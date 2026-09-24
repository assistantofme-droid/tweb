/*
 * Realtime counterpart of the REST bridge: a Socket.IO connection to the
 * 7eve9Chat backend whose events are turned into TL updates and fed through
 * the normal updates pipeline (see RestBridge.dispatchUpdates), so chats
 * update live.
 */

import type {Chat, Peer, Update, User} from '@layer';
import type {RestBridge, Json} from '@lib/sevenNine/restBridge';
import {io, Socket} from 'socket.io-client';
import tsNow from '@helpers/tsNow';
import {SEVEN_NINE_SOCKET} from '@lib/sevenNine/config';
import {idFromMongoId, idFromMongoIdInt32, isMongoId, parseIsoToEpochSeconds} from '@lib/sevenNine/ids';
import {jsonStr} from '@lib/sevenNine/restBridge';

const OWN_SEND_WAIT_STEP = 250;
const OWN_SEND_WAIT_MAX = 30e3;

type Listener = (...args: any[]) => void;

export default class SocketBridge {
  private socket: Socket;
  private connectedUserId: string;
  // group / channel rooms (typing etc. are broadcast per room), re-joined on reconnect
  private rooms: Set<string> = new Set();
  // pinned set per conversation, to turn "current pins" snapshots into pin / unpin updates
  private pinnedByConversation: Map<string, Set<number>> = new Map();
  private hadConnection = false;

  constructor(private bridge: RestBridge) {}

  public connect() {
    const userId = this.bridge.selfMongoId;
    if(!userId || (this.socket && this.connectedUserId === userId)) {
      return;
    }

    this.disconnect();
    this.connectedUserId = userId;
    const socket = this.socket = io(SEVEN_NINE_SOCKET, {
      query: {userId},
      auth: {token: this.bridge.token},
      reconnection: true,
      forceNew: true,
      transports: ['websocket', 'polling']
    });

    const on = (event: string, callback: (data: Json) => void | Promise<void>) => {
      socket.on(event, (data: any) => {
        if(!data || typeof(data) !== 'object') return;
        try {
          const result = callback(data);
          if(result instanceof Promise) {
            result.catch((err) => this.bridge.log.error('socket', event, err));
          }
        } catch(err) {
          this.bridge.log.error('socket', event, err);
        }
      });
    };

    on('new_message', (data) => this.onNewMessage(data));
    on('messages_read', (data) => this.onMessagesRead(data));
    on('user_status_change', (data) => this.onUserStatusChange(data));
    on('typing', (data) => this.onTyping(data, true));
    on('stop_typing', (data) => this.onTyping(data, false));
    on('new_conversation', (data) => this.onNewConversation(data));
    on('conversation_deleted', (data) => this.onConversationGone(data));
    on('removed_from_conversation', (data) => this.onConversationGone(data));
    on('member_kicked', (data) => this.onMemberKicked(data));
    on('message_updated', (data) => this.onMessageUpdated(data));
    on('message_deleted', (data) => this.onMessageDeleted(data));
    on('message_reaction', (data) => this.onMessageReaction(data));
    on('pins_updated', (data) => this.onPinsUpdated(data));
    on('conversation_updated', (data) => this.onConversationUpdated(data));
    on('user_updated', (data) => this.onUserUpdated(data));
    on('gifts_changed', (data) => this.bridge.onGiftsChanged(data));

    socket.on('connect', () => {
      this.bridge.setConnectionStatus(true);
      for(const room of this.rooms) {
        socket.emit('join_conversation', room);
      }

      // catch up on anything sent while offline
      if(this.hadConnection) {
        this.bridge.catchUp();
      }

      this.hadConnection = true;
    });

    socket.on('disconnect', () => {
      this.bridge.setConnectionStatus(false);
    });

    socket.on('connect_error', (err) => {
      this.bridge.log.warn('socket connect error', err?.message);
      this.bridge.setConnectionStatus(false);
    });
  }

  public disconnect() {
    if(this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = undefined;
    }

    this.connectedUserId = undefined;
    this.hadConnection = false;
  }

  public isConnected() {
    return !!this.socket?.connected;
  }

  public getSocketId() {
    return this.socket?.id;
  }

  public joinConversation(conversationId: string) {
    if(!conversationId || this.rooms.has(conversationId)) return;
    this.rooms.add(conversationId);
    if(this.socket?.connected) {
      this.socket.emit('join_conversation', conversationId);
    }
  }

  public emit(event: string, data?: any) {
    if(this.socket?.connected) {
      this.socket.emit(event, data);
    }
  }

  /** for features with their own socket protocol (calls) */
  public on(event: string, listener: Listener) {
    this.socket?.on(event, listener);
  }

  public off(event: string, listener: Listener) {
    this.socket?.off(event, listener);
  }

  private async resolvePeer(conversationId: string, users: User[], chats: Chat[]): Promise<Peer> {
    if(!conversationId) return undefined;
    const known = this.bridge.resolvePeerForConversationId(conversationId);
    if(known) return known;

    // first message of a chat we haven't listed yet
    try {
      const peer = await this.bridge.fetchAndRegisterConversation(conversationId, users, chats);
      if(peer) this.joinConversation(conversationId);
      return peer;
    } catch(err) {
      return undefined;
    }
  }

  // See RestHttp "own-message echoes": wait while this client is sending,
  // then drop the echo of a message it sent itself.
  private async onNewMessage(m: Json, waited = 0): Promise<void> {
    const http = this.bridge.http;
    const mongoId = jsonStr(m, '_id');
    if(http.wasSentByThisClient(mongoId)) {
      return;
    }

    if(http.isOwnSendInFlight() && waited < OWN_SEND_WAIT_MAX) {
      await new Promise((resolve) => setTimeout(resolve, OWN_SEND_WAIT_STEP));
      return this.onNewMessage(m, waited + OWN_SEND_WAIT_STEP);
    }

    const users: User[] = [], chats: Chat[] = [];
    const peer = await this.resolvePeer(jsonStr(m, 'conversationId'), users, chats);
    if(!peer) return;

    const message = this.bridge.buildAnyMessage(m, peer);
    if(message._ === 'message' && message.pFlags.mentioned && !message.pFlags.out) {
      message.pFlags.media_unread = true; // counts toward the "@" badge until opened
    }

    const updates: Update[] = [this.bridge.newMessageUpdate(message)];
    // "wallpaper changed" changes the background right away
    if(message._ === 'messageService' && message.action._ === 'messageActionSetChatWallPaper') {
      updates.push({
        _: 'updatePeerWallpaper',
        pFlags: message.action.pFlags.for_both ? {} : {wallpaper_overridden: true},
        peer: message.peer_id,
        wallpaper: message.action.wallpaper
      });
    }

    this.bridge.addSender(m, users);
    this.bridge.dispatchUpdates(updates, users, chats);
  }

  private onMessagesRead(data: Json) {
    const conversationId = jsonStr(data, 'conversationId');
    const userId = jsonStr(data, 'userId');
    if(!conversationId || !userId) return;
    const peer = this.bridge.resolvePeerForConversationId(conversationId);
    if(!peer) return;

    const maxId = this.bridge.getTopServerMessageId(peer);
    if(!maxId) return;

    const isChannel = peer._ === 'peerChannel';
    let update: Update;
    if(userId === this.bridge.selfMongoId) {
      // read by me on another device
      update = isChannel ? {
        _: 'updateReadChannelInbox',
        channel_id: peer.channel_id,
        max_id: maxId,
        still_unread_count: 0,
        pts: 0
      } : {
        _: 'updateReadHistoryInbox',
        peer,
        max_id: maxId,
        still_unread_count: 0,
        pts: 0,
        pts_count: 0
      };
    } else {
      update = isChannel ? {
        _: 'updateReadChannelOutbox',
        channel_id: peer.channel_id,
        max_id: maxId
      } : {
        _: 'updateReadHistoryOutbox',
        peer,
        max_id: maxId,
        pts: 0,
        pts_count: 0
      };
    }

    this.bridge.dispatchUpdates([update]);
  }

  private onUserStatusChange(data: Json) {
    const userId = jsonStr(data, 'userId');
    if(!isMongoId(userId)) return;
    const userTlId = idFromMongoId(userId);
    const lastSeen = jsonStr(data, 'lastSeen');
    const status: Update.updateUserStatus['status'] = data.isOnline ? {
      _: 'userStatusOnline',
      expires: tsNow(true) + 60
    } : {
      _: 'userStatusOffline',
      was_online: lastSeen ? parseIsoToEpochSeconds(lastSeen) : tsNow(true)
    };

    this.bridge.rememberUserStatus(userTlId, status);
    this.bridge.dispatchUpdates([{_: 'updateUserStatus', user_id: userTlId, status}]);
  }

  private onTyping(data: Json, isTyping: boolean) {
    const conversationId = jsonStr(data, 'conversationId');
    const userId = jsonStr(data, 'userId');
    if(!conversationId || !isMongoId(userId) || userId === this.bridge.selfMongoId) return;
    const peer = this.bridge.resolvePeerForConversationId(conversationId);
    if(!peer) return;

    const userTlId = idFromMongoId(userId);
    const action: Update.updateUserTyping['action'] = isTyping ?
      {_: 'sendMessageTypingAction'} :
      {_: 'sendMessageCancelAction'};
    const update: Update = peer._ === 'peerUser' ? {
      _: 'updateUserTyping',
      user_id: userTlId,
      action
    } : {
      _: 'updateChannelUserTyping',
      channel_id: (peer as Peer.peerChannel).channel_id,
      from_id: {_: 'peerUser', user_id: userTlId},
      action
    };

    this.bridge.dispatchUpdates([update]);
  }

  private async onNewConversation(data: Json) {
    const conv: Json = data.conversation && typeof(data.conversation) === 'object' ? data.conversation : data;
    const conversationId = jsonStr(conv, '_id') || jsonStr(data, 'conversationId');
    if(!conversationId) return;
    this.joinConversation(conversationId);
    await this.bridge.reloadConversation(conversationId);
  }

  private onConversationGone(data: Json) {
    const conversationId = jsonStr(data, 'conversationId') || jsonStr(data, '_id');
    if(conversationId) {
      this.bridge.removeConversation(conversationId);
    }
  }

  private onMemberKicked(data: Json) {
    const conversationId = jsonStr(data, 'conversationId');
    const userId = jsonStr(data, 'userId');
    if(!conversationId) return;
    if(!userId || userId === this.bridge.selfMongoId) {
      this.bridge.removeConversation(conversationId);
    } else {
      this.bridge.reloadConversation(conversationId);
    }
  }

  private onMessageUpdated(data: Json) {
    const full: Json = data.fullMessage;
    if(!full) return;
    const conversationId = jsonStr(full, 'conversationId') || jsonStr(data, 'conversationId');
    const peer = this.bridge.resolvePeerForConversationId(conversationId);
    if(!peer) return;
    const message = this.bridge.buildAnyMessage(full, peer);
    const users: User[] = [];
    this.bridge.addSender(full, users);
    this.bridge.dispatchUpdates([this.bridge.editMessageUpdate(message)], users);
  }

  private onMessageDeleted(data: Json) {
    const messageId = jsonStr(data, 'messageId');
    const conversationId = jsonStr(data, 'conversationId');
    if(!isMongoId(messageId) || !conversationId) return;
    const peer = this.bridge.resolvePeerForConversationId(conversationId);
    if(!peer) return;

    const tlId = idFromMongoIdInt32(messageId);
    this.bridge.dispatchUpdates([peer._ === 'peerChannel' ? {
      _: 'updateDeleteChannelMessages',
      channel_id: peer.channel_id,
      messages: [tlId],
      pts: 0,
      pts_count: 0
    } : {
      _: 'updateDeleteMessages',
      messages: [tlId],
      pts: 0,
      pts_count: 0
    }]);
  }

  private onMessageReaction(data: Json) {
    const messageId = jsonStr(data, 'messageId');
    const conversationId = jsonStr(data, 'conversationId');
    if(!isMongoId(messageId) || !conversationId) return;
    const peer = this.bridge.resolvePeerForConversationId(conversationId);
    if(!peer) return;

    this.bridge.rememberMyReaction(messageId, data.reactions);
    this.bridge.dispatchUpdates([this.bridge.reactionsUpdate(peer, idFromMongoIdInt32(messageId), data.reactions)]);
  }

  private onPinsUpdated(data: Json) {
    const conversationId = jsonStr(data, 'conversationId');
    const peer = this.bridge.resolvePeerForConversationId(conversationId);
    if(!peer) return;

    const now: Set<number> = new Set();
    const pins: any[] = Array.isArray(data.pinnedMessages) ? data.pinnedMessages : [];
    for(const p of pins) {
      const id = p && typeof(p) === 'object' ? String(p._id) : String(p);
      if(isMongoId(id)) {
        now.add(this.bridge.rememberMessageId(id));
      }
    }

    const before = this.pinnedByConversation.get(conversationId);
    this.pinnedByConversation.set(conversationId, now);
    const added = [...now].filter((id) => !before?.has(id));
    const removed = before ? [...before].filter((id) => !now.has(id)) : [];
    const updates: Update[] = [];
    if(added.length) updates.push(this.bridge.pinUpdate(peer, added, true));
    if(removed.length) updates.push(this.bridge.pinUpdate(peer, removed, false));
    this.bridge.dispatchUpdates(updates);
  }

  // group / channel info changed (title, photo, members, permissions...)
  private onConversationUpdated(conv: Json) {
    if(conv.type !== 'group' && conv.type !== 'channel') return;
    const chats: Chat[] = [];
    const peer = this.bridge.registerConversationChat(conv, chats);
    this.bridge.dispatchUpdates([{_: 'updateChannel', channel_id: (peer as Peer.peerChannel).channel_id}], [], chats);
  }

  private onUserUpdated(userJson: Json) {
    if(!userJson._id) return;
    this.bridge.applyUserUpdate(userJson);
  }
}
