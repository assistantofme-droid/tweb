/*
 * 7eve9Chat REST bridge.
 *
 * Replaces MTProto for the whole app: every `apiManager.invokeApi` call is
 * answered here, by translating the TL method into calls to the 7eve9Chat
 * REST backend (the one the 7eve9Chat Android client and website use) and the
 * JSON it returns back into TL objects. Realtime events come over Socket.IO
 * (see `socketBridge.ts`) and are fed into the normal updates pipeline.
 *
 * Nothing ever reaches Telegram's servers. Methods without a translation fail
 * with a silent `REST_BRIDGE_UNIMPLEMENTED:<method>` error (code 406).
 *
 * Ids: backend objects are addressed by MongoDB ObjectId. Users and
 * conversations keep theirs in `access_hash`, so any InputPeer / InputUser /
 * InputChannel the app sends back carries it; see `ids.ts` for the TL ids.
 */

import type {
  Chat,
  ChatAdminRights,
  ChatBannedRights,
  ChatPhoto,
  Document,
  DocumentAttribute,
  InputChannel,
  InputFile,
  InputMedia,
  InputPeer,
  InputQuickReplyShortcut,
  InputReplyTo,
  InputUser,
  KeyboardButton,
  KeyboardInlineButton,
  Message,
  MessageEntity,
  MessageMedia,
  MessageReactions,
  MethodDeclMap,
  Peer,
  PeerColor,
  Photo,
  PhotosPhoto,
  PhotoSize,
  ReactionCount,
  ReplyMarkup,
  Update,
  Updates,
  User,
  UserProfilePhoto,
  UserStatus,
  WallPaper,
  WallPaperSettings,
  WebPage
} from '@layer';
import type {InvokeApiOptions} from '@types';
import {AppManager} from '@appManagers/manager';
import AccountController from '@lib/accounts/accountController';
import parseEntities from '@lib/richTextProcessor/parseEntities';
import tsNow from '@helpers/tsNow';
import {ConnectionStatus} from '@lib/mtproto/connectionStatus';
import RestHttp from '@lib/sevenNine/http';
import BridgeStore from '@lib/sevenNine/store';
import {SEVEN_NINE_DC_ID, SEVEN_NINE_ORIGIN} from '@lib/sevenNine/config';
import {genericError, RestException, tlError, unimplementedError} from '@lib/sevenNine/errors';
import {idForUrl, idFromMongoId, idFromMongoIdInt32, isMongoId, parseIsoToEpochSeconds} from '@lib/sevenNine/ids';
import SocketBridge from '@lib/sevenNine/socketBridge';
import registerAllHandlers from '@lib/sevenNine/handlers';

export type BridgeHandler<M extends keyof MethodDeclMap> = (
  params: MethodDeclMap[M]['req'],
  options: InvokeApiOptions
) => MethodDeclMap[M]['res'] | Promise<MethodDeclMap[M]['res']>;

export type BridgeHandlers = {
  [M in keyof MethodDeclMap]?: BridgeHandler<M>
};

export type Json = Record<string, any>;

type AnyInput = InputPeer | InputUser | InputChannel | Peer;

// Reactions: the same set and emoji strings as the website's picker, so a
// reaction looks the same everywhere. Artwork is Twemoji (CC-BY 4.0) as
// vector .tgs, served by the backend from /uploads/reactions/.
export const REACTIONS: [emoji: string, file: string, title: string][] = [
  ['👍', '1f44d', 'Thumbs Up'],
  ['❤️', '2764', 'Red Heart'],
  ['😂', '1f602', 'Tears of Joy'],
  ['😮', '1f62e', 'Surprised'],
  ['😢', '1f622', 'Crying'],
  ['🙏', '1f64f', 'Folded Hands'],
  ['🔥', '1f525', 'Fire'],
  ['😍', '1f60d', 'Heart Eyes'],
  ['👏', '1f44f', 'Clapping'],
  ['🎉', '1f389', 'Party'],
  ['🤔', '1f914', 'Thinking'],
  ['😡', '1f621', 'Angry'],
  ['👎', '1f44e', 'Thumbs Down'],
  ['💯', '1f4af', 'Hundred'],
  ['🤩', '1f929', 'Star-Struck'],
  ['😁', '1f601', 'Grinning']
];

const ADMIN_RIGHT_KEYS: [server: string, tl: keyof ChatAdminRights.chatAdminRights['pFlags']][] = [
  ['changeInfo', 'change_info'], ['postMessages', 'post_messages'], ['editMessages', 'edit_messages'],
  ['deleteMessages', 'delete_messages'], ['banUsers', 'ban_users'], ['inviteUsers', 'invite_users'],
  ['pinMessages', 'pin_messages'], ['addAdmins', 'add_admins'], ['anonymous', 'anonymous'],
  ['manageCall', 'manage_call'], ['manageTopics', 'manage_topics'], ['postStories', 'post_stories'],
  ['editStories', 'edit_stories'], ['deleteStories', 'delete_stories']
];

const MESSAGE_LOOKUP_MISS_TTL = 60e3;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** JSON null / missing / the string "null" -> undefined */
export function jsonStr(o: Json, key: string): string {
  const v = o?.[key];
  if(v === undefined || v === null) return undefined;
  const s = String(v);
  return s === 'null' ? undefined : s;
}

/** owner/admins etc. come back either as plain ids or as populated objects */
export function refId(o: Json, key: string): string {
  const v = o?.[key];
  if(v && typeof(v) === 'object') return v._id ? String(v._id) : undefined;
  return v === undefined || v === null ? undefined : String(v);
}

export function idListContains(list: any[], id: string) {
  if(!Array.isArray(list) || !id) return false;
  return list.some((item) => (item && typeof(item) === 'object' ? String(item._id) : String(item)) === id);
}

export function base64ToBytes(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; ++i) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  } catch(err) {
    return undefined;
  }
}

export function bytesToBase64(bytes: Uint8Array | number[]) {
  let binary = '';
  for(let i = 0; i < bytes.length; ++i) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

export function normalizePhone(phone: string) {
  let p = (phone || '').replace(/\D/g, '');
  if(p.startsWith('98') && p.length >= 10) {
    p = '0' + p.slice(2);
  } else if(p.startsWith('9') && p.length === 10) {
    p = '0' + p;
  }

  return p;
}

export function joinName(first: string, last: string) {
  const f = (first || '').trim();
  const l = (last || '').trim();
  return l ? (f + ' ' + l).trim() : f;
}

export class RestBridge extends AppManager {
  public http: RestHttp;
  public socket: SocketBridge;
  public token: string;
  public selfMongoId: string;

  private store: BridgeStore;
  private ready: Promise<void>;

  // set by the messages / business handlers (shared between the two)
  public sendMediaMessage: (
    peer: InputPeer,
    media: InputMedia,
    caption: string,
    replyTo: InputReplyTo,
    entities: MessageEntity[],
    quickReplyTarget?: Json
  ) => Promise<Json>;
  public setBotPhoto: (bot: InputUser, file: InputFile) => Promise<PhotosPhoto.photosPhoto>;
  public sendToQuickReply: (
    shortcut: InputQuickReplyShortcut,
    items: {media?: InputMedia, message: string, entities?: MessageEntity[], random_id: string | number}[]
  ) => Promise<Updates.updates>;
  private handlers: BridgeHandlers;

  // TL peer <-> backend conversation
  private conversationIdByUserPeer: Map<number, string> = new Map();
  private conversationIdByChatPeer: Map<number, string> = new Map();
  private peerByConversationId: Map<string, Peer> = new Map();
  // TL user id -> backend user id
  private userMongoIdByTlId: Map<number, string> = new Map();
  // TL media id -> URL (+ size when known)
  private mediaUrlById: Map<string, string> = new Map();
  private mediaSizeById: Map<string, number> = new Map();
  private videoUrlByPhotoId: Map<string, string> = new Map();
  // TL message id -> backend message id (see getMessageMongoId)
  private messageMongoIdByTlId: Map<number, string> = new Map();
  private messageLookupMisses: Map<number, number> = new Map();

  public channelTlIds: Set<number> = new Set();
  public broadcastTlIds: Set<number> = new Set();
  public contactMongoIds: Set<string> = new Set();
  public viewOnceMessages: Set<string> = new Set();
  // channel TL id -> linked discussion group (or, for a group, its channel) id
  public linkedChatMongoIdByTlId: Map<number, string> = new Map();
  // channel post TL id -> its comment-thread anchor id
  public anchorMongoIdByPostTlId: Map<number, string> = new Map();
  public storyMongoIdByTlId: Map<number, string> = new Map();
  public stickerSetMongoIdById: Map<string, string> = new Map();
  public botConfigById: Map<string, Json> = new Map();
  public botCreatorById: Map<string, string> = new Map();
  public gameShortNameByMsg: Map<number, string> = new Map();
  public forwardUsers: Map<number, Json> = new Map();
  public myReactionByMessage: Map<string, string> = new Map();
  public sessionHashToDeviceId: Map<string, string> = new Map();
  private statusByUser: Map<number, UserStatus> = new Map();

  protected after() {
    this.name = '7E9';
    this.http = new RestHttp(() => this.token);
    this.store = new BridgeStore(this.getAccountNumber());
    this.socket = new SocketBridge(this);
    this.handlers = registerAllHandlers(this);
    this.ready = this.load();
  }

  private async load() {
    const [accountData, peers, media, users, contacts, deviceId] = await Promise.all([
      AccountController.get(this.getAccountNumber()),
      this.store.load<{users: [number, string][], chats: [number, string][], channels: number[], broadcasts: number[]}>('peers'),
      this.store.load<[string, string, number?][]>('media'),
      this.store.load<[number, string][]>('users'),
      this.store.load<string[]>('contacts'),
      this.store.load<string>('device')
    ]);

    this.deviceId = deviceId;

    this.token = accountData.seven_nine_token;
    this.selfMongoId = accountData.seven_nine_self_id;

    peers?.users?.forEach(([tlId, convId]) => this.registerUserConversation(tlId, convId, false));
    peers?.chats?.forEach(([tlId, convId]) => this.registerChatConversation(tlId, convId, false));
    peers?.channels?.forEach((tlId) => this.channelTlIds.add(tlId));
    peers?.broadcasts?.forEach((tlId) => this.broadcastTlIds.add(tlId));
    media?.forEach(([id, url, size]) => {
      this.mediaUrlById.set(id, url);
      if(size) this.mediaSizeById.set(id, size);
    });
    users?.forEach(([tlId, mongoId]) => this.userMongoIdByTlId.set(tlId, mongoId));
    contacts?.forEach((id) => this.contactMongoIds.add(id));
  }

  // ---------------------------------------------------------------------------
  // Entry point (ApiManager.invokeApi)
  // ---------------------------------------------------------------------------

  public invoke(method: string, params: any, options: InvokeApiOptions): Promise<any> {
    const handler = this.handlers[method as keyof MethodDeclMap] as BridgeHandler<any>;
    return this.ready.then(() => {
      this.maybeConnectSocket();
      if(!handler) {
        this.log.warn('unimplemented', method, params);
        throw unimplementedError(method);
      }

      return handler(params || {}, options || {});
    }).catch((err) => {
      if(!(err && err.type && err.code)) {
        this.log.error(method, err);
      }

      throw genericError(err);
    });
  }

  public hasHandler(method: string) {
    return !!this.handlers[method as keyof MethodDeclMap];
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  public async setSession(token: string, selfMongoId: string) {
    this.token = token;
    this.selfMongoId = selfMongoId;
    await AccountController.update(this.getAccountNumber(), {
      seven_nine_token: token,
      seven_nine_self_id: selfMongoId
    });
  }

  public async clearSession() {
    this.token = undefined;
    this.selfMongoId = undefined;
    this.deviceId = undefined;
    this.socket.disconnect();
    await Promise.all([
      AccountController.update(this.getAccountNumber(), {
        seven_nine_token: undefined,
        seven_nine_self_id: undefined
      }),
      this.store.clear()
    ]);
  }

  // managers the handlers read from (the app's own caches)
  public get usersManager() {
    return this.appUsersManager;
  }

  public get chatsManager() {
    return this.appChatsManager;
  }

  public get docsManager() {
    return this.appDocsManager;
  }

  public get peersManager() {
    return this.appPeersManager;
  }

  public get messagesManager() {
    return this.appMessagesManager;
  }

  /** the language the app's interface is in */
  public get uiLanguage() {
    return this.networkerFactory.language;
  }

  public isAuthorized() {
    return !!(this.token && this.selfMongoId);
  }

  public maybeConnectSocket() {
    if(this.isAuthorized()) {
      this.socket.connect();
    }
  }

  public get selfTlId() {
    return this.selfMongoId ? idFromMongoId(this.selfMongoId) : 0;
  }

  public get selfUsernames(): string[] {
    const self = this.appUsersManager.getSelf();
    if(!self) return [];
    const out = self.username ? [self.username] : [];
    self.usernames?.forEach((u) => out.push(u.username));
    return out;
  }

  private deviceId: string;
  /** one id per login on this browser (sessions list, "this device") */
  public getDeviceId() {
    if(!this.deviceId) {
      const random = new Uint8Array(8);
      crypto.getRandomValues(random);
      this.deviceId = 'web-' + Array.from(random, (b) => ('0' + b.toString(16)).slice(-2)).join('');
      this.store.save('device', () => this.deviceId);
    }

    return this.deviceId;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private savePeers() {
    this.store.save('peers', () => ({
      users: [...this.conversationIdByUserPeer],
      chats: [...this.conversationIdByChatPeer],
      channels: [...this.channelTlIds],
      broadcasts: [...this.broadcastTlIds]
    }));
  }

  private saveMedia() {
    this.store.save('media', () => [...this.mediaUrlById].map(([id, url]) => {
      const size = this.mediaSizeById.get(id);
      return size ? [id, url, size] : [id, url];
    }));
  }

  private saveUsers() {
    this.store.save('users', () => [...this.userMongoIdByTlId]);
  }

  public saveContacts() {
    this.store.save('contacts', () => [...this.contactMongoIds]);
  }

  // ---------------------------------------------------------------------------
  // Peers <-> conversations
  // ---------------------------------------------------------------------------

  public rememberUser(tlId: number, mongoId: string) {
    if(!isMongoId(mongoId) || this.userMongoIdByTlId.get(tlId) === mongoId) return;
    this.userMongoIdByTlId.set(tlId, mongoId);
    this.saveUsers();
  }

  public registerUserConversation(userTlId: number, conversationId: string, save = true) {
    if(!isMongoId(conversationId)) return;
    const prev = this.conversationIdByUserPeer.get(userTlId);
    this.conversationIdByUserPeer.set(userTlId, conversationId);
    this.peerByConversationId.set(conversationId, {_: 'peerUser', user_id: userTlId});
    if(save && prev !== conversationId) this.savePeers();
  }

  public registerChatConversation(chatTlId: number, conversationId: string, save = true) {
    if(!isMongoId(conversationId)) return;
    const prev = this.conversationIdByChatPeer.get(chatTlId);
    this.conversationIdByChatPeer.set(chatTlId, conversationId);
    this.peerByConversationId.set(conversationId, {_: 'peerChannel', channel_id: chatTlId});
    if(save && prev !== conversationId) this.savePeers();
  }

  public getChatConversationIds() {
    return this.conversationIdByChatPeer;
  }

  /** The TL peer the app knows a conversation as (registered by dialogs etc.) */
  public resolvePeerForConversationId(conversationId: string): Peer {
    return this.peerByConversationId.get(conversationId);
  }

  public getUserMongoId(userTlId: number) {
    if(userTlId === this.selfTlId) return this.selfMongoId;
    const mongoId = this.userMongoIdByTlId.get(userTlId);
    if(mongoId) return mongoId;
    const user = this.appUsersManager.getUser(userTlId);
    const accessHash = user?.access_hash && String(user.access_hash);
    return isMongoId(accessHash) ? accessHash : undefined;
  }

  /** Backend user id of an InputUser / InputPeerUser / PeerUser / TL id */
  public userMongoIdOf(input: AnyInput | number): string {
    if(typeof(input) === 'number') return this.getUserMongoId(input);
    if(!input) return undefined;
    switch(input._) {
      case 'inputUserSelf':
      case 'inputPeerSelf':
        return this.selfMongoId;
      case 'inputUser':
      case 'inputPeerUser': {
        const accessHash = String(input.access_hash ?? '');
        return isMongoId(accessHash) ? accessHash : this.getUserMongoId(+input.user_id);
      }
      case 'inputUserFromMessage':
      case 'inputPeerUserFromMessage':
        return this.getUserMongoId(+input.user_id);
      case 'peerUser':
        return this.getUserMongoId(+input.user_id);
    }

    return undefined;
  }

  public userTlIdOf(input: AnyInput): number {
    if(!input) return undefined;
    switch(input._) {
      case 'inputUserSelf':
      case 'inputPeerSelf':
        return this.selfTlId;
      case 'inputUser':
      case 'inputPeerUser':
      case 'inputUserFromMessage':
      case 'inputPeerUserFromMessage':
      case 'peerUser':
        return +input.user_id;
    }

    return undefined;
  }

  public chatTlIdOf(input: AnyInput): number {
    if(!input) return undefined;
    switch(input._) {
      case 'inputChannel':
      case 'inputPeerChannel':
      case 'inputChannelFromMessage':
      case 'inputPeerChannelFromMessage':
      case 'peerChannel':
        return +input.channel_id;
      case 'inputPeerChat':
      case 'peerChat':
        return +input.chat_id;
    }

    return undefined;
  }

  /** Backend conversation id of a group / channel input */
  public chatConversationIdOf(input: AnyInput | number): string {
    if(typeof(input) === 'number') {
      const id = this.conversationIdByChatPeer.get(input);
      if(id) return id;
      const chat = this.appChatsManager.getChat(input) as Chat.channel;
      const accessHash = chat?.access_hash && String(chat.access_hash);
      return isMongoId(accessHash) ? accessHash : undefined;
    }

    if(!input) return undefined;
    if((input._ === 'inputChannel' || input._ === 'inputPeerChannel') && isMongoId(String(input.access_hash ?? ''))) {
      const convId = String(input.access_hash);
      if(!this.conversationIdByChatPeer.has(+input.channel_id)) {
        this.registerChatConversation(+input.channel_id, convId);
      }

      return convId;
    }

    const chatTlId = this.chatTlIdOf(input);
    return chatTlId ? this.chatConversationIdOf(chatTlId) : undefined;
  }

  private conversationsSyncPromise: Promise<void>;
  private lastConversationsSync = 0;
  /**
   * Refreshes the id maps from the conversation list (a peer the app restored
   * from its own cache after the maps were lost, e.g. site data cleared).
   */
  public syncConversations(force?: boolean): Promise<void> {
    if(this.conversationsSyncPromise) return this.conversationsSyncPromise;
    if(!force && Date.now() - this.lastConversationsSync < 10e3) return Promise.resolve();
    this.lastConversationsSync = Date.now();
    return this.conversationsSyncPromise = this.http.requestArray('GET', '/messages/conversations').then((conversations) => {
      for(const conv of conversations) {
        this.registerConversation(conv, [], []);
      }
    }).catch(() => {}).finally(() => {
      this.conversationsSyncPromise = undefined;
    });
  }

  /** Conversation of any peer (private chats may need a lookup) */
  public async conversationIdOf(input: AnyInput, lookup = true): Promise<string> {
    if(!input) return undefined;
    const userTlId = this.userTlIdOf(input);
    if(userTlId !== undefined) {
      let convId = this.conversationIdByUserPeer.get(userTlId);
      if(!convId && lookup) {
        await this.syncConversations();
        convId = this.conversationIdByUserPeer.get(userTlId);
      }

      return convId;
    }

    let convId = this.chatConversationIdOf(input);
    if(!convId && lookup) {
      await this.syncConversations();
      convId = this.chatConversationIdOf(input);
    }

    return convId;
  }

  public async requireConversationIdOf(input: AnyInput) {
    const convId = await this.conversationIdOf(input);
    if(!convId) {
      throw tlError(400, 'PEER_ID_INVALID');
    }

    return convId;
  }

  /**
   * Target of a new message: the conversation when known, otherwise the
   * receiver for a first message to a user (the backend creates the chat).
   */
  public async putMessageTarget(body: Json, peer: InputPeer) {
    const convId = await this.conversationIdOf(peer);
    if(convId) {
      body.conversationId = convId;
      return;
    }

    const receiver = this.userMongoIdOf(peer);
    if(receiver) {
      body.receiverId = receiver;
      return;
    }

    throw tlError(400, 'PEER_ID_INVALID');
  }

  public rememberSentConversation(peer: InputPeer, sent: Json) {
    const userTlId = this.userTlIdOf(peer);
    const convId = jsonStr(sent, 'conversationId');
    if(userTlId !== undefined && isMongoId(convId) && !this.conversationIdByUserPeer.has(userTlId)) {
      this.registerUserConversation(userTlId, convId);
    }
  }

  public peerFromInput(input: AnyInput): Peer {
    const userTlId = this.userTlIdOf(input);
    if(userTlId !== undefined) {
      return {_: 'peerUser', user_id: userTlId};
    }

    const chatTlId = this.chatTlIdOf(input);
    return chatTlId !== undefined ? {_: 'peerChannel', channel_id: chatTlId} : undefined;
  }

  public getPeerId(peer: Peer): PeerId {
    return this.appPeersManager.getPeerId(peer);
  }

  public isChannelTlId(tlId: number) {
    if(this.channelTlIds.has(tlId)) return true;
    return this.appChatsManager.getChat(tlId)?._ === 'channel';
  }

  public isBroadcast(chatTlId: number) {
    return this.broadcastTlIds.has(chatTlId);
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  public rememberMessageId(mongoId: string) {
    if(!isMongoId(mongoId)) return undefined;
    const tlId = idFromMongoIdInt32(mongoId);
    this.messageMongoIdByTlId.set(tlId, mongoId);
    return tlId;
  }

  /**
   * Messages shown from the app's own cache (or sent from here, whose echo is
   * dropped) may not be in the map yet: their TL id is the backend's sequence
   * number, resolved with GET /messages/by-seq/<id>.
   */
  public async getMessageMongoId(tlId: number): Promise<string> {
    tlId = this.appMessagesIdsManager.getMessageIdInfo(tlId).messageId;
    const known = this.messageMongoIdByTlId.get(tlId);
    if(known || tlId <= 0) return known;

    const missedAt = this.messageLookupMisses.get(tlId);
    if(missedAt && Date.now() - missedAt < MESSAGE_LOOKUP_MISS_TTL) {
      return undefined;
    }

    try {
      const json = await this.http.request('GET', '/messages/by-seq/' + tlId);
      const id = jsonStr(json, '_id');
      if(isMongoId(id)) {
        this.messageMongoIdByTlId.set(tlId, id);
        return id;
      }
    } catch(err) {}

    this.messageLookupMisses.set(tlId, Date.now());
    return undefined;
  }

  public async getMessageMongoIds(tlIds: number[]) {
    const out: string[] = [];
    for(const tlId of tlIds) {
      const id = await this.getMessageMongoId(tlId);
      if(id) out.push(id);
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  public absoluteUrl(ref: string) {
    if(!ref) return ref;
    if(/^https?:\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('blob:')) return ref;
    return SEVEN_NINE_ORIGIN + (ref.startsWith('/') ? ref : '/' + ref);
  }

  /** "/uploads/..." for a backend URL (what the backend stores) */
  public relativeUploadPath(url: string) {
    if(!url) return undefined;
    const i = url.indexOf('/uploads/');
    return i >= 0 ? url.slice(i) : undefined;
  }

  public registerMedia(url: string, size?: number) {
    const id = idForUrl(url);
    let changed = false;
    if(this.mediaUrlById.get(id) !== url) {
      this.mediaUrlById.set(id, url);
      changed = true;
    }

    if(size > 0 && this.mediaSizeById.get(id) !== size) {
      this.mediaSizeById.set(id, size);
      changed = true;
    }

    if(changed) this.saveMedia();
    return id;
  }

  public getMediaUrl(id: string | number) {
    return this.mediaUrlById.get(String(id));
  }

  public getMediaSize(id: string | number) {
    return this.mediaSizeById.get(String(id));
  }

  public getVideoUrlForPhoto(id: string | number) {
    return this.videoUrlByPhotoId.get(String(id));
  }

  public fileReferenceFor(url: string) {
    return textEncoder.encode(url);
  }

  public urlFromFileReference(fileReference: Uint8Array | number[]) {
    if(!fileReference?.length) return undefined;
    try {
      const url = textDecoder.decode(fileReference instanceof Uint8Array ? fileReference : new Uint8Array(fileReference));
      return /^https?:\/\//.test(url) ? url : undefined;
    } catch(err) {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Uploads: the app streams a file as upload.saveFilePart chunks and then
  // references it by id; the backend takes whole multipart uploads, so the
  // parts are kept here until the request that uses the file.
  // ---------------------------------------------------------------------------

  private uploads: Map<string, ArrayBuffer[]> = new Map();

  public saveFilePart(fileId: string | number, part: number, bytes: ArrayBuffer | Uint8Array) {
    const key = String(fileId);
    let parts = this.uploads.get(key);
    if(!parts) this.uploads.set(key, parts = []);
    parts[part] = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  }

  public takeUpload(inputFile: InputFile, mimeType?: string): Blob {
    if(!inputFile || (inputFile._ !== 'inputFile' && inputFile._ !== 'inputFileBig')) {
      throw tlError(400, 'FILE_PARTS_INVALID');
    }

    const key = String(inputFile.id);
    const parts = this.uploads.get(key);
    const total = inputFile.parts || parts?.length || 0;
    if(!parts || parts.length < total) {
      throw tlError(400, 'FILE_PARTS_INVALID');
    }

    for(let i = 0; i < total; ++i) {
      if(!parts[i]) throw tlError(400, 'FILE_PART_' + i + '_MISSING');
    }

    this.uploads.delete(key);
    return new Blob(parts.slice(0, total), mimeType ? {type: mimeType} : undefined);
  }

  public buildStrippedThumb(base64: string): PhotoSize.photoStrippedSize {
    const bytes = base64 ? base64ToBytes(base64) : undefined;
    if(!bytes || bytes.length < 4 || bytes[0] !== 1) return undefined;
    return {_: 'photoStrippedSize', type: 'i', bytes, h: bytes[1], w: bytes[2]};
  }

  public buildPhoto(url: string, options: {w?: number, h?: number, size?: number, thumb?: string, date?: number} = {}): Photo.photo {
    const id = this.registerMedia(url, options.size);
    const sizes: PhotoSize[] = [];
    const stripped = this.buildStrippedThumb(options.thumb);
    if(stripped) sizes.push(stripped);
    sizes.push({
      _: 'photoSize',
      type: 'x',
      w: options.w || 1280,
      h: options.h || 1280,
      size: options.size || 0
    });

    return {
      _: 'photo',
      pFlags: {},
      id,
      access_hash: '0',
      file_reference: this.fileReferenceFor(url),
      date: options.date || tsNow(true),
      sizes,
      dc_id: SEVEN_NINE_DC_ID
    };
  }

  /** Full profile photo; a video avatar adds a "u" video size */
  public buildProfilePhoto(avatar: string, avatarVideo?: string): Photo.photo {
    const photo = this.buildPhoto(this.absoluteUrl(avatar), {w: 640, h: 640});
    if(avatarVideo) {
      this.videoUrlByPhotoId.set(String(photo.id), this.absoluteUrl(avatarVideo));
      photo.video_sizes = [{
        _: 'videoSize',
        type: 'u',
        w: 800,
        h: 800,
        size: 0,
        video_start_ts: 0
      }];
    }

    return photo;
  }

  public buildUserProfilePhoto(avatar: string, avatarVideo?: string): UserProfilePhoto {
    if(!avatar) return {_: 'userProfilePhotoEmpty'};
    const url = this.absoluteUrl(avatar);
    const photoId = this.registerMedia(url);
    if(avatarVideo) {
      this.videoUrlByPhotoId.set(photoId, this.absoluteUrl(avatarVideo));
    }

    return {
      _: 'userProfilePhoto',
      pFlags: avatarVideo ? {has_video: true} : {},
      photo_id: photoId,
      dc_id: SEVEN_NINE_DC_ID
    };
  }

  public buildChatPhoto(conv: Json): ChatPhoto {
    const avatar = jsonStr(conv, 'avatar');
    if(!avatar || avatar.startsWith('data:')) return {_: 'chatPhotoEmpty'};
    return {
      _: 'chatPhoto',
      pFlags: {},
      photo_id: this.registerMedia(this.absoluteUrl(avatar)),
      dc_id: SEVEN_NINE_DC_ID
    };
  }

  public buildFullChatPhoto(conv: Json): Photo {
    const avatar = jsonStr(conv, 'avatar');
    if(!avatar || avatar.startsWith('data:')) return {_: 'photoEmpty', id: '0'};
    return this.buildPhoto(this.absoluteUrl(avatar), {w: 640, h: 640});
  }

  public buildDocument(url: string, mimeType: string, fileName: string, kind: string, options: {
    size?: number,
    meta?: Json,
    thumb?: string,
    date?: number
  } = {}): Document.document {
    if(kind === 'sticker') {
      // animated stickers / emoji made from a video or GIF are VP9 WebM files
      const path = (url || '').toLowerCase().split('?')[0];
      if(path.endsWith('.webm')) mimeType = 'video/webm';
      else if(path.endsWith('.tgs')) mimeType = 'application/x-tgsticker';
      else if(path.endsWith('.png')) mimeType = 'image/png';
    }

    const meta = options.meta || {};
    const duration = +meta.duration > 0 ? +meta.duration : 0;
    const width = +meta.width > 0 ? +meta.width : 0;
    const height = +meta.height > 0 ? +meta.height : 0;
    const isTgs = mimeType === 'application/x-tgsticker';
    // the app reads the type from the attributes in order: the defining one goes last
    const attributes: DocumentAttribute[] = [{
      _: 'documentAttributeFilename',
      // the app only animates .tgs files with this name
      file_name: isTgs ? 'AnimatedSticker.tgs' : (fileName || 'file')
    }];

    if(kind === 'sticker') {
      if(mimeType === 'video/webm') {
        attributes.push({_: 'documentAttributeVideo', pFlags: {}, duration: 0, w: 512, h: 512});
      } else {
        attributes.push({_: 'documentAttributeImageSize', w: 512, h: 512});
      }

      attributes.push({
        _: 'documentAttributeSticker',
        pFlags: {},
        alt: meta.emoji || '',
        stickerset: {_: 'inputStickerSetEmpty'}
      });
    } else if(kind === 'video' || kind === 'gif' || kind === 'round') {
      attributes.push({
        _: 'documentAttributeVideo',
        pFlags: {
          supports_streaming: true,
          ...(kind === 'round' ? {round_message: true} : {}),
          ...(kind === 'gif' ? {nosound: true} : {})
        },
        duration,
        w: width || (kind === 'round' ? 384 : 1280),
        h: height || (kind === 'round' ? 384 : 720)
      });

      if(kind === 'gif') {
        attributes.push({_: 'documentAttributeAnimated'});
      }
    } else if(kind === 'audio' || kind === 'voice') {
      const waveform = kind === 'voice' && jsonStr(meta, 'waveform') ? base64ToBytes(meta.waveform) : undefined;
      attributes.push({
        _: 'documentAttributeAudio',
        pFlags: kind === 'voice' ? {voice: true} : {},
        duration,
        ...(meta.title ? {title: String(meta.title)} : {}),
        ...(meta.performer ? {performer: String(meta.performer)} : {}),
        ...(waveform ? {waveform} : {})
      });
    } else if(kind === 'photo' && width && height) {
      attributes.push({_: 'documentAttributeImageSize', w: width, h: height});
    }

    const thumbs: Document.document['thumbs'] = [];
    const stripped = this.buildStrippedThumb(options.thumb);
    if(stripped) thumbs.push(stripped);

    return {
      _: 'document',
      pFlags: {},
      id: this.registerMedia(url, options.size),
      access_hash: '0',
      file_reference: this.fileReferenceFor(url),
      date: options.date || tsNow(true),
      mime_type: mimeType as any,
      size: options.size || 0,
      dc_id: SEVEN_NINE_DC_ID,
      attributes,
      ...(thumbs.length ? {thumbs} : {})
    };
  }

  public buildDocumentMedia(url: string, mimeType: string, fileName: string, kind: string, options?: Parameters<RestBridge['buildDocument']>[4]): MessageMedia.messageMediaDocument {
    return {
      _: 'messageMediaDocument',
      pFlags: {
        ...(kind === 'video' || kind === 'gif' ? {video: true} : {}),
        ...(kind === 'voice' ? {voice: true} : {}),
        ...(kind === 'round' ? {round: true} : {})
      },
      document: this.buildDocument(url, mimeType, fileName, kind, options)
    };
  }

  public buildPhotoMedia(url: string, options?: Parameters<RestBridge['buildPhoto']>[1]): MessageMedia.messageMediaPhoto {
    return {
      _: 'messageMediaPhoto',
      pFlags: {},
      photo: this.buildPhoto(url, options)
    };
  }

  /** a vector (.tgs) sticker document served by the backend */
  public buildTgsDocument(url: string): Document.document {
    return this.buildDocument(url, 'application/x-tgsticker', 'AnimatedSticker.tgs', 'sticker', {date: 1});
  }

  public buildAvailableReactions(): MethodDeclMap['messages.getAvailableReactions']['res'] {
    return {
      _: 'messages.availableReactions',
      hash: 7979,
      reactions: REACTIONS.map(([emoji, file, title]) => {
        const base = SEVEN_NINE_ORIGIN + '/uploads/reactions/' + file;
        const loop = this.buildTgsDocument(base + '.tgs');
        const appear = this.buildTgsDocument(base + '_appear.tgs');
        const effect = this.buildTgsDocument(base + '_effect.tgs');
        return {
          _: 'availableReaction',
          pFlags: {},
          reaction: emoji,
          title,
          static_icon: loop,
          appear_animation: appear,
          select_animation: loop,
          activate_animation: appear,
          effect_animation: effect,
          around_animation: effect,
          center_icon: loop
        };
      })
    };
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  public buildPeerColor(json: Json): PeerColor {
    if(!json || json.color === undefined || json.color === null) return undefined;
    const color: PeerColor.peerColor = {_: 'peerColor', color: +json.color};
    const bg = jsonStr(json, 'backgroundEmojiId');
    if(bg && /^\d+$/.test(bg)) color.background_emoji_id = bg;
    return color;
  }

  public buildUser(u: Json, self = String(u._id) === this.selfMongoId): User.user {
    const mongoId = String(u._id);
    const id = idFromMongoId(mongoId);
    this.rememberUser(id, mongoId);

    const name = String(u.name || '').trim();
    let first = name, last = '';
    const sp = name.indexOf(' ');
    if(sp > 0) {
      first = name.slice(0, sp);
      last = name.slice(sp + 1);
    }

    if(!first) {
      first = jsonStr(u, 'phone') || 'User';
    }

    const user: User.user = {
      _: 'user',
      pFlags: {},
      id,
      access_hash: mongoId,
      first_name: first
    };

    if(last) user.last_name = last;

    const username = jsonStr(u, 'username');
    if(username) user.username = username;

    // extra usernames: shown as "also @a, @b" on the profile
    const extra: string[] = Array.isArray(u.additionalUsernames) ? u.additionalUsernames.filter(Boolean) : [];
    if(extra.length) {
      user.usernames = [];
      if(username) {
        user.usernames.push({_: 'username', pFlags: {active: true, ...(self ? {editable: true as const} : {})}, username});
      }

      for(const e of extra) {
        if(e.toLowerCase() === (username || '').toLowerCase()) continue;
        user.usernames.push({_: 'username', pFlags: {active: true}, username: e});
      }
    }

    const phone = jsonStr(u, 'phone');
    if(phone && (self || !u.isPhoneHidden)) {
      user.phone = phone.replace(/^0/, '98');
    }

    const pFlags = user.pFlags;
    if(self) pFlags.self = true;
    // only real contacts, otherwise "Add to contacts" disappears
    if(self || this.contactMongoIds.has(mongoId)) pFlags.contact = true;
    if(u.isVerified) pFlags.verified = true;
    if(u.isScam) pFlags.scam = true;
    if(u.isFake) pFlags.fake = true;
    if(u.isPremium) pFlags.premium = true;

    if(u.isBot) {
      pFlags.bot = true;
      user.bot_info_version = 1;
      if(u.menuButton?.type === 'web_app') pFlags.bot_has_main_app = true;
      let botCfg: Json = u.bot;
      if(botCfg && typeof(botCfg) === 'object') this.botConfigById.set(mongoId, botCfg);
      else botCfg = this.botConfigById.get(mongoId);
      let creator = refId(u, 'creatorId');
      if(creator) this.botCreatorById.set(mongoId, creator);
      else creator = this.botCreatorById.get(mongoId);
      if(botCfg) {
        if('privacy' in botCfg && !botCfg.privacy) pFlags.bot_chat_history = true;
        if('joinGroups' in botCfg && !botCfg.joinGroups) pFlags.bot_nochats = true;
        const placeholder = jsonStr(botCfg, 'inlinePlaceholder');
        if(placeholder) user.bot_inline_placeholder = placeholder;
      }

      if(creator && creator === this.selfMongoId) pFlags.bot_can_edit = true;
    }

    const status = this.buildUserStatus(id, u, self, !!u.isBot);
    if(status) user.status = status;

    const emojiUrl = u.emojiStatus && jsonStr(u.emojiStatus, 'url');
    if(emojiUrl) {
      user.emoji_status = {
        _: 'emojiStatus',
        document_id: this.registerMedia(this.absoluteUrl(emojiUrl)),
        ...(+u.emojiStatus.until > 0 ? {until: +u.emojiStatus.until} : {})
      };
    }

    const color = this.buildPeerColor(u.nameColor);
    if(color) user.color = color;
    const profileColor = this.buildPeerColor(u.profileTgColor);
    if(profileColor) user.profile_color = profileColor;

    const avatar = jsonStr(u, 'avatar');
    if(avatar && !avatar.startsWith('data:')) {
      user.photo = this.buildUserProfilePhoto(avatar, jsonStr(u, 'avatarVideo'));
    }

    return user;
  }

  /**
   * Presence. Many payloads (e.g. a message's sender) don't include it, and a
   * user without a status would read "last seen a long time ago", so the last
   * known one is kept.
   */
  public buildUserStatus(userTlId: number, u: Json, self: boolean, bot: boolean): UserStatus {
    if(bot) return undefined;
    const now = tsNow(true);
    let status: UserStatus;
    if(self || u.isOnline === true) {
      status = {_: 'userStatusOnline', expires: now + 300};
    } else if(jsonStr(u, 'lastSeen')) {
      status = {_: 'userStatusOffline', was_online: parseIsoToEpochSeconds(u.lastSeen)};
    } else if('isOnline' in u) {
      // presence known, last seen hidden by privacy
      status = {_: 'userStatusRecently', pFlags: {}};
    }

    if(status) {
      this.statusByUser.set(userTlId, status);
      return status;
    }

    return this.statusByUser.get(userTlId);
  }

  public rememberUserStatus(userTlId: number, status: UserStatus) {
    if(status) this.statusByUser.set(userTlId, status);
  }

  public addUserOnce(users: User[], user: User) {
    if(!users.some((u) => u.id === user.id)) {
      users.push(user);
    }
  }

  /** the sender, forwarded-from and via-bot users of a message JSON */
  public addSender(m: Json, users: User[]) {
    for(const key of ['forwardedFrom', 'sender', 'viaBot']) {
      const u = m?.[key];
      if(u && typeof(u) === 'object' && u._id && (key !== 'forwardedFrom' || u.name)) {
        this.addUserOnce(users, this.buildUser(u));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Groups / channels
  // ---------------------------------------------------------------------------

  public isSelfAdmin(conv: Json) {
    return idListContains(conv.admins, this.selfMongoId);
  }

  public fullAdminRights(): ChatAdminRights.chatAdminRights {
    return {
      _: 'chatAdminRights',
      pFlags: {
        change_info: true,
        post_messages: true,
        edit_messages: true,
        delete_messages: true,
        ban_users: true,
        invite_users: true,
        pin_messages: true,
        manage_call: true,
        other: true,
        post_stories: true,
        edit_stories: true,
        delete_stories: true
      }
    };
  }

  /** undefined when the user is not an admin / the owner of conv */
  public adminRightsFor(conv: Json, userId: string): ChatAdminRights.chatAdminRights {
    if(!userId) return undefined;
    const owner = userId === refId(conv, 'owner');
    const admin = owner || idListContains(conv.admins, userId);
    if(!admin) return undefined;
    const rights = this.fullAdminRights();
    const pFlags = rights.pFlags;
    const stored: Json = conv.adminRights?.[userId];
    if(owner) {
      pFlags.add_admins = true;
      pFlags.manage_topics = true;
    } else if(stored) {
      for(const [server, tl] of ADMIN_RIGHT_KEYS) {
        if(stored[server]) pFlags[tl] = true;
        else delete pFlags[tl];
      }
    } else {
      // promoted before per-admin rights existed: everything but adding admins
      pFlags.manage_topics = true;
    }

    if(idListContains(conv.anonymousAdmins, userId)) pFlags.anonymous = true;
    else delete pFlags.anonymous;
    pFlags.other = true;
    if(conv.type === 'channel') {
      delete pFlags.manage_topics;
    } else {
      delete pFlags.post_messages;
      delete pFlags.edit_messages;
    }

    if(!conv.isVerified) {
      // stories are for blue-tick groups / channels only
      delete pFlags.post_stories;
      delete pFlags.edit_stories;
      delete pFlags.delete_stories;
    }

    return rights;
  }

  public adminRightsToJson(rights: ChatAdminRights) {
    const out: Json = {};
    const pFlags = rights?.pFlags || {};
    for(const [server, tl] of ADMIN_RIGHT_KEYS) {
      out[server] = !!pFlags[tl];
    }

    return out;
  }

  /** backend defaultPermissions (what members MAY do) -> banned rights */
  public defaultBannedRights(perms: Json): ChatBannedRights.chatBannedRights {
    const rights: ChatBannedRights.chatBannedRights = {_: 'chatBannedRights', pFlags: {}, until_date: 0};
    if(!perms) return rights;
    const pFlags = rights.pFlags;
    const deny = (key: string) => perms[key] === false;
    if(deny('canSendMessages')) pFlags.send_messages = pFlags.send_plain = true;
    if(deny('canSendMedia')) pFlags.send_media = pFlags.send_photos = pFlags.send_videos = pFlags.send_roundvideos = true;
    if(deny('canSendFiles')) pFlags.send_docs = pFlags.send_audios = true;
    if(deny('canSendVoice')) pFlags.send_voices = true;
    if(deny('canSendPolls')) pFlags.send_polls = true;
    if(deny('canSendGifs')) pFlags.send_gifs = pFlags.send_stickers = true;
    if(deny('canSendLinks')) pFlags.embed_links = true;
    if(deny('canAddMembers')) pFlags.invite_users = true;
    if(deny('canPinMessages')) pFlags.pin_messages = true;
    if(deny('canChangeGroupInfo')) pFlags.change_info = true;
    if(deny('canManageTopics')) pFlags.manage_topics = true;
    return rights;
  }

  public bannedRightsToPermissions(rights: ChatBannedRights) {
    const pFlags = rights?.pFlags || {};
    return {
      canSendMessages: !pFlags.send_messages && !pFlags.send_plain,
      canSendMedia: !pFlags.send_media && !pFlags.send_photos && !pFlags.send_videos,
      canSendFiles: !pFlags.send_docs,
      canSendVoice: !pFlags.send_voices,
      canSendPolls: !pFlags.send_polls,
      canSendGifs: !pFlags.send_gifs && !pFlags.send_stickers,
      canSendLinks: !pFlags.embed_links,
      canAddMembers: !pFlags.invite_users,
      canPinMessages: !pFlags.pin_messages,
      canChangeGroupInfo: !pFlags.change_info,
      canManageTopics: !pFlags.manage_topics
    };
  }

  /** a member's current restriction entry, if any and not expired */
  public activeRestriction(conv: Json, userId: string): Json {
    const list: Json[] = Array.isArray(conv.restrictedUsers) ? conv.restrictedUsers : [];
    const now = Date.now();
    for(const entry of list) {
      if(refId(entry, 'user') !== userId) continue;
      const until = jsonStr(entry, 'until');
      if(until && Date.parse(until) < now) continue;
      return entry;
    }

    return undefined;
  }

  public restrictionRights(entry: Json): ChatBannedRights.chatBannedRights {
    const rights = this.defaultBannedRights(entry?.restrictions);
    const until = entry && jsonStr(entry, 'until');
    if(until) rights.until_date = parseIsoToEpochSeconds(until);
    return rights;
  }

  public customTitleFor(conv: Json, userId: string) {
    const title = conv.customTitles?.[userId];
    return title && title !== 'null' ? String(title) : '';
  }

  public promotedByFor(conv: Json, userId: string): string {
    return jsonStr(conv.adminRights?.[userId], 'promotedBy');
  }

  /**
   * Groups and channels are both TL channels (groups as megagroups: that's
   * what all the member / admin / ban / slow mode handlers speak).
   */
  public buildChannel(conv: Json, tlId = idFromMongoId(String(conv._id))): Chat.channel {
    const convId = String(conv._id);
    this.channelTlIds.add(tlId);
    const megagroup = conv.type !== 'channel';
    if(megagroup) this.broadcastTlIds.delete(tlId);
    else this.broadcastTlIds.add(tlId);

    const channel: Chat.channel = {
      _: 'channel',
      pFlags: megagroup ? {megagroup: true} : {broadcast: true},
      id: tlId,
      access_hash: convId,
      title: String(conv.name || (megagroup ? 'Group' : 'Channel')),
      photo: this.buildChatPhoto(conv),
      date: parseIsoToEpochSeconds(conv.createdAt)
    };

    const pFlags = channel.pFlags;
    if(conv.isVerified) pFlags.verified = true;
    if(conv.showSignatures) pFlags.signatures = true;
    if(conv.protectedContent) pFlags.noforwards = true;
    if(conv.approveNewMembers) pFlags.join_request = true;
    if(+conv.slowModeInterval > 0) pFlags.slowmode_enabled = true;
    if(conv.joinToSend) pFlags.join_to_send = true;

    const handle = jsonStr(conv, 'handle');
    if(handle && !conv.isPrivateLink) channel.username = handle;

    if(Array.isArray(conv.participants)) {
      channel.participants_count = conv.participants.length;
      if(!idListContains(conv.participants, this.selfMongoId)) pFlags.left = true;
    } else if('participantsCount' in conv) {
      channel.participants_count = +conv.participantsCount || 0;
      pFlags.left = true;
    }

    if(refId(conv, 'owner') === this.selfMongoId) pFlags.creator = true;
    const adminRights = this.adminRightsFor(conv, this.selfMongoId);
    if(adminRights) {
      channel.admin_rights = adminRights;
    } else if(megagroup && this.selfMongoId) {
      const restriction = this.activeRestriction(conv, this.selfMongoId);
      if(restriction) channel.banned_rights = this.restrictionRights(restriction);
    }

    if(megagroup) {
      channel.default_banned_rights = this.defaultBannedRights(conv.defaultPermissions);
    }

    const color = this.buildPeerColor(conv.nameColor);
    if(color) channel.color = color;
    const profileColor = this.buildPeerColor(conv.profileTgColor);
    if(profileColor) channel.profile_color = profileColor;

    const voiceCall = conv.voiceCall;
    if(voiceCall?.isLive) {
      pFlags.call_active = true;
      if(Array.isArray(voiceCall.participants) && voiceCall.participants.length) pFlags.call_not_empty = true;
    }

    const linked = refId(conv, 'linkedDiscussionGroupId') || refId(conv, 'discussionForChannelId');
    if(isMongoId(linked)) {
      this.linkedChatMongoIdByTlId.set(tlId, linked);
      pFlags.has_link = true;
    }

    this.registerChatConversation(tlId, convId);
    return channel;
  }

  /** Registers a backend group / channel and returns its peer */
  public registerConversationChat(conv: Json, chats: Chat[]): Peer {
    const channel = this.buildChannel(conv);
    if(!chats.some((c) => c.id === channel.id)) chats.push(channel);
    return {_: 'peerChannel', channel_id: +channel.id};
  }

  /** The other participant of a private chat (me for Saved Messages) */
  public otherParticipant(conv: Json): Json {
    const participants: Json[] = Array.isArray(conv.participants) ? conv.participants : [];
    const objects = participants.filter((p) => p && typeof(p) === 'object');
    return objects.find((p) => String(p._id) !== this.selfMongoId) || objects[0];
  }

  /** Registers any backend conversation, filling users / chats; returns its peer */
  public registerConversation(conv: Json, users: User[], chats: Chat[]): Peer {
    if(!conv?._id) return undefined;
    const type = conv.type || 'private';
    if(type === 'group' || type === 'channel') {
      return this.registerConversationChat(conv, chats);
    }

    const other = this.otherParticipant(conv);
    if(!other) return undefined;
    const user = this.buildUser(other);
    this.addUserOnce(users, user);
    this.registerUserConversation(+user.id, String(conv._id));
    return {_: 'peerUser', user_id: +user.id};
  }

  /** A conversation the app has never seen (e.g. a first message arriving live) */
  public async fetchAndRegisterConversation(conversationId: string, users: User[], chats: Chat[]): Promise<Peer> {
    const conv = await this.http.request('GET', '/messages/conversations/' + conversationId);
    return this.registerConversation(conv, users, chats);
  }

  public ensureChannelState(channelTlId: number) {
    try {
      this.apiUpdatesManager.getChannelState(channelTlId, 1);
    } catch(err) {}
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  /** Links / @mentions / #hashtags / /commands / emails, as the app itself detects them */
  public detectEntities(text: string): MessageEntity[] {
    if(!text) return [];
    try {
      return parseEntities(text).filter((e) => e._ !== 'messageEntityEmoji' as any);
    } catch(err) {
      return [];
    }
  }

  public entitiesFromJson(list: Json[]): MessageEntity[] {
    const out: MessageEntity[] = [];
    if(!Array.isArray(list)) return out;
    for(const j of list) {
      if(!j) continue;
      const offset = +j.offset || 0, length = +j.length || 0;
      if(length <= 0) continue;
      switch(j.type) {
        case 'bold': out.push({_: 'messageEntityBold', offset, length}); break;
        case 'italic': out.push({_: 'messageEntityItalic', offset, length}); break;
        case 'underline': out.push({_: 'messageEntityUnderline', offset, length}); break;
        case 'strike': out.push({_: 'messageEntityStrike', offset, length}); break;
        case 'spoiler': out.push({_: 'messageEntitySpoiler', offset, length}); break;
        case 'code': out.push({_: 'messageEntityCode', offset, length}); break;
        case 'pre': out.push({_: 'messageEntityPre', offset, length, language: j.language || ''}); break;
        case 'text_url': out.push({_: 'messageEntityTextUrl', offset, length, url: j.url || ''}); break;
        case 'blockquote': out.push({_: 'messageEntityBlockquote', pFlags: {}, offset, length}); break;
        case 'custom_emoji': {
          const url = jsonStr(j, 'documentUrl');
          const documentId = url ? this.registerMedia(this.absoluteUrl(url)) : jsonStr(j, 'documentId');
          if(!documentId || !/^\d+$/.test(documentId)) continue;
          out.push({_: 'messageEntityCustomEmoji', offset, length, document_id: documentId});
          break;
        }
        case 'mention_name': {
          const userId = jsonStr(j, 'userId');
          if(!isMongoId(userId)) continue;
          const tlId = idFromMongoId(userId);
          this.rememberUser(tlId, userId);
          out.push({_: 'messageEntityMentionName', offset, length, user_id: tlId});
          break;
        }
      }
    }

    return out;
  }

  /**
   * Formatting the user typed (bold, spoiler...) -> backend JSON. Detected
   * links / mentions are rebuilt on receipt, so they're skipped.
   */
  public entitiesToJson(entities: MessageEntity[]): Json[] {
    const out: Json[] = [];
    if(!entities) return out;
    for(const e of entities) {
      let type: string;
      let userId: string;
      switch(e._) {
        case 'messageEntityBold': type = 'bold'; break;
        case 'messageEntityItalic': type = 'italic'; break;
        case 'messageEntityUnderline': type = 'underline'; break;
        case 'messageEntityStrike': type = 'strike'; break;
        case 'messageEntitySpoiler': type = 'spoiler'; break;
        case 'messageEntityCode': type = 'code'; break;
        case 'messageEntityPre': type = 'pre'; break;
        case 'messageEntityTextUrl': type = 'text_url'; break;
        case 'messageEntityBlockquote': type = 'blockquote'; break;
        case 'messageEntityCustomEmoji': type = 'custom_emoji'; break;
        case 'inputMessageEntityMentionName':
          userId = this.userMongoIdOf(e.user_id);
          type = userId ? 'mention_name' : undefined;
          break;
        case 'messageEntityMentionName':
          userId = this.getUserMongoId(+e.user_id);
          type = userId ? 'mention_name' : undefined;
          break;
      }

      if(!type || e.length <= 0) continue;
      const j: Json = {type, offset: e.offset, length: e.length};
      if(e._ === 'messageEntityTextUrl' && e.url) j.url = e.url;
      if(e._ === 'messageEntityPre' && e.language) j.language = e.language;
      if(userId) j.userId = userId;
      if(e._ === 'messageEntityCustomEmoji') {
        j.documentId = String(e.document_id);
        const path = this.relativeUploadPath(this.getMediaUrl(e.document_id));
        if(path) j.documentUrl = path;
      }

      out.push(j);
    }

    return out;
  }

  /** Tagged by id / @username, or in the server's "mentions" list */
  public mentionsMe(m: Json, text: string, entities: MessageEntity[]) {
    if(!this.selfMongoId) return false;
    const senderId = m.sender && typeof(m.sender) === 'object' ? String(m.sender._id) : jsonStr(m, 'sender');
    if(senderId === this.selfMongoId) return false;
    if(Array.isArray(m.mentions) && m.mentions.some((id: any) => String(id) === this.selfMongoId)) return true;
    const selfTlId = this.selfTlId;
    let usernames: string[];
    for(const e of entities) {
      if(e._ === 'messageEntityMentionName' && +e.user_id === selfTlId) return true;
      if(e._ === 'messageEntityMention' && text && e.offset + e.length <= text.length) {
        usernames ??= this.selfUsernames.map((u) => u.toLowerCase());
        const tag = text.slice(e.offset, e.offset + e.length).replace('@', '').toLowerCase();
        if(usernames.includes(tag)) return true;
      }
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  public buildMessageReactions(reactions: Json[], canSeeList?: boolean): MessageReactions.messageReactions {
    if(!Array.isArray(reactions) || !reactions.length) return undefined;
    const counts: Map<string, number> = new Map();
    let mine: string;
    for(const r of reactions) {
      const emoji = r && jsonStr(r, 'emoji');
      if(!emoji) continue;
      counts.set(emoji, (counts.get(emoji) || 0) + 1);
      if(this.selfMongoId && refId(r, 'user') === this.selfMongoId) mine = emoji;
    }

    if(!counts.size) return undefined;
    const results: ReactionCount[] = [];
    for(const [emoji, count] of counts) {
      const reactionCount: ReactionCount.reactionCount = {
        _: 'reactionCount',
        reaction: emoji.startsWith('custom:/uploads/') ? {
          _: 'reactionCustomEmoji',
          document_id: this.registerMedia(this.absoluteUrl(emoji.slice('custom:'.length)))
        } : {
          _: 'reactionEmoji',
          emoticon: emoji
        },
        count
      };

      if(emoji === mine) reactionCount.chosen_order = 1;
      results.push(reactionCount);
    }

    return {
      _: 'messageReactions',
      pFlags: canSeeList ? {can_see_list: true} : {},
      results
    };
  }

  public rememberMyReaction(messageMongoId: string, reactions: Json[]) {
    if(!messageMongoId) return;
    let mine: string;
    if(Array.isArray(reactions) && this.selfMongoId) {
      for(const r of reactions) {
        if(r && refId(r, 'user') === this.selfMongoId) mine = jsonStr(r, 'emoji');
      }
    }

    if(mine) this.myReactionByMessage.set(messageMongoId, mine);
    else this.myReactionByMessage.delete(messageMongoId);
  }

  public buildWebPageMedia(lp: Json): MessageMedia.messageMediaWebPage {
    const url = lp && jsonStr(lp, 'url');
    if(!url) return undefined;
    let display = url.replace(/^https?:\/\//i, '');
    if(display.startsWith('www.')) display = display.slice(4);
    if(display.endsWith('/')) display = display.slice(0, -1);
    const page: WebPage.webPage = {
      _: 'webPage',
      pFlags: {},
      id: idForUrl('webpage:' + url),
      url,
      display_url: display,
      hash: 0
    };

    let site = jsonStr(lp, 'siteName');
    if(!site) {
      try {
        site = new URL(url).host.replace(/^www\./, '');
      } catch(err) {}
    }

    if(site) page.site_name = site;
    const title = jsonStr(lp, 'title');
    if(title) page.title = title;
    const description = jsonStr(lp, 'description');
    if(description) page.description = description;
    const image = jsonStr(lp, 'image');
    if(image) page.photo = this.buildPhoto(this.absoluteUrl(image));
    return {_: 'messageMediaWebPage', pFlags: {}, webpage: page};
  }

  public buildPollMedia(poll: Json, messageMongoId: string): MessageMedia.messageMediaPoll {
    const options: Json[] = Array.isArray(poll.options) ? poll.options : [];
    let totalVoters = 0;
    const answers: MessageMedia.messageMediaPoll['poll']['answers'] = [];
    const results: MessageMedia.messageMediaPoll['results']['results'] = [];
    options.forEach((opt, i) => {
      const option = textEncoder.encode(String(opt.id ?? i));
      answers.push({
        _: 'pollAnswer',
        text: {_: 'textWithEntities', text: String(opt.text || ''), entities: []},
        option
      });

      const votes = +opt.votes || 0;
      totalVoters += votes;
      const chosen = this.selfMongoId && Array.isArray(opt.voters) && opt.voters.some((v: any) => String(v?._id ?? v) === this.selfMongoId);
      results.push({
        _: 'pollAnswerVoters',
        pFlags: chosen ? {chosen: true} : {},
        option,
        voters: votes
      });
    });

    return {
      _: 'messageMediaPoll',
      poll: {
        _: 'poll',
        id: String(idFromMongoId(messageMongoId)),
        pFlags: {
          ...(poll.multiSelect ? {multiple_choice: true as const} : {}),
          ...(poll.isClosed ? {closed: true as const} : {}),
          ...(poll.isAnonymous === false ? {public_voters: true as const} : {})
        },
        question: {_: 'textWithEntities', text: String(poll.question || ''), entities: []},
        answers,
        hash: 0
      },
      results: {
        _: 'pollResults',
        pFlags: {},
        results,
        total_voters: totalVoters
      }
    };
  }

  public buildReplyMarkup(markup: Json): ReplyMarkup {
    try {
      if(Array.isArray(markup.inline_keyboard)) {
        return {
          _: 'replyInlineMarkup',
          pFlags: {},
          rows: markup.inline_keyboard.filter(Array.isArray).map((row: Json[]) => ({
            _: 'keyboardInlineButtonRow',
            buttons: row.filter(Boolean).map((b): KeyboardInlineButton => {
              const text = String(b.text || '');
              let type: KeyboardInlineButton['type'];
              if(b.url) {
                type = {_: 'inlineButtonTypeUrl', url: String(b.url)};
              } else if(b.callback_game) {
                type = {_: 'inlineButtonTypeGame'};
              } else if('switch_inline_query' in b || 'switch_inline_query_current_chat' in b || 'switch_inline_query_chosen_chat' in b) {
                const samePeer = 'switch_inline_query_current_chat' in b;
                type = {
                  _: 'inlineButtonTypeSwitchInline',
                  pFlags: samePeer ? {same_peer: true} : {},
                  query: String(samePeer ? b.switch_inline_query_current_chat : b.switch_inline_query_chosen_chat?.query ?? b.switch_inline_query ?? '')
                };
              } else if(b.copy_text) {
                type = {_: 'inlineButtonTypeCopy', copy_text: String(b.copy_text.text || '')};
              } else if(b.login_url) {
                type = {_: 'inlineButtonTypeUrl', url: String(b.login_url.url || '')};
              } else if(b.web_app) {
                type = {_: 'inlineButtonTypeWebView', url: String(b.web_app.url || '')};
              } else {
                type = {_: 'inlineButtonTypeCallback', pFlags: {}, data: textEncoder.encode(String(b.callback_data ?? text))};
              }

              return {_: 'keyboardInlineButton', text, type};
            })
          }))
        };
      }

      if(Array.isArray(markup.keyboard)) {
        const result: ReplyMarkup.replyKeyboardMarkup = {
          _: 'replyKeyboardMarkup',
          pFlags: {},
          rows: markup.keyboard.filter(Array.isArray).map((row: any[]) => ({
            _: 'keyboardButtonRow',
            buttons: row.map((item): KeyboardButton => {
              const b: Json = item && typeof(item) === 'object' ? item : {text: String(item)};
              let type: KeyboardButton['type'];
              if(b.web_app?.url) type = {_: 'buttonTypeSimpleWebView', url: String(b.web_app.url)};
              else if(b.request_contact) type = {_: 'buttonTypeRequestPhone'};
              else if(b.request_location) type = {_: 'buttonTypeRequestGeoLocation'};
              else if(b.request_poll) type = {_: 'buttonTypeRequestPoll', ...(b.request_poll.type === 'quiz' ? {quiz: true} : {})};
              else type = {_: 'buttonTypeDefault'};
              return {_: 'keyboardButton', text: String(b.text || ''), type};
            })
          }))
        };

        if(markup.resize_keyboard !== false) result.pFlags.resize = true;
        if(markup.one_time_keyboard) result.pFlags.single_use = true;
        if(markup.is_persistent) result.pFlags.persistent = true;
        if(markup.input_field_placeholder) result.placeholder = String(markup.input_field_placeholder);
        return result;
      }

      if(markup.remove_keyboard) {
        return {_: 'replyKeyboardHide', pFlags: {}};
      }

      if(markup.force_reply) {
        return {
          _: 'replyKeyboardForceReply',
          pFlags: markup.selective ? {selective: true} : {},
          ...(markup.input_field_placeholder ? {placeholder: String(markup.input_field_placeholder)} : {})
        };
      }
    } catch(err) {
      this.log.error('reply markup', err);
    }

    return undefined;
  }

  private buildFileMedia(m: Json, type: string, url: string): MessageMedia {
    const fileName = jsonStr(m, 'fileName');
    const size = +m.fileSize > 0 ? +m.fileSize : 0;
    const meta: Json = m.mediaMeta && typeof(m.mediaMeta) === 'object' ? m.mediaMeta : {};
    const thumb = jsonStr(m, 'thumb');
    const date = parseIsoToEpochSeconds(m.createdAt);
    switch(type) {
      case 'image':
        return this.buildPhotoMedia(url, {w: +meta.width || 0, h: +meta.height || 0, size, thumb, date});
      case 'video':
        return this.buildDocumentMedia(url, jsonStr(m, 'mimeType') || 'video/mp4', fileName, 'video', {size, meta, thumb, date});
      case 'video_note':
      case 'round':
        return this.buildDocumentMedia(url, 'video/mp4', fileName, 'round', {size, meta, thumb, date});
      case 'voice':
        return this.buildDocumentMedia(url, 'audio/ogg', fileName, 'voice', {size, meta, date});
      case 'audio':
        return this.buildDocumentMedia(url, jsonStr(m, 'mimeType') || 'audio/mpeg', fileName, 'audio', {size, meta, date});
      case 'gif':
        return this.buildDocumentMedia(url, 'video/mp4', fileName, 'gif', {size, meta, thumb, date});
      case 'sticker':
        return this.buildDocumentMedia(url, 'image/webp', fileName, 'sticker', {size, meta, date});
      default:
        return this.buildDocumentMedia(url, jsonStr(m, 'mimeType') || 'application/octet-stream', fileName, 'file', {size, meta, thumb, date});
    }
  }

  public buildMessage(m: Json, peer: Peer): Message.message {
    const mongoId = String(m._id);
    const id = this.rememberMessageId(mongoId);
    const channelTlId = peer._ === 'peerChannel' ? +peer.channel_id : undefined;
    const isBroadcast = channelTlId !== undefined && this.broadcastTlIds.has(channelTlId);
    const type: string = m.type || 'text';
    let text = jsonStr(m, 'text') || '';

    const message: Message.message = {
      _: 'message',
      pFlags: {},
      id,
      peer_id: peer,
      date: parseIsoToEpochSeconds(m.createdAt),
      message: text
    };

    const entities = this.detectEntities(text);
    entities.push(...this.entitiesFromJson(m.entities));
    if(this.mentionsMe(m, text, entities)) message.pFlags.mentioned = true;

    let media: MessageMedia;
    if(type === 'poll' && m.poll) {
      media = this.buildPollMedia(m.poll, mongoId);
    }

    const fileUrl = jsonStr(m, 'fileUrl');
    if(fileUrl) {
      media = this.buildFileMedia(m, type, this.absoluteUrl(fileUrl));
      if(m.hasSpoiler && (media._ === 'messageMediaPhoto' || media._ === 'messageMediaDocument')) {
        media.pFlags.spoiler = true;
      }

      const timer = m.selfDestructTimer;
      if(timer !== undefined && timer !== null && (media._ === 'messageMediaPhoto' || media._ === 'messageMediaDocument')) {
        if(String(timer) === 'view_once') {
          media.ttl_seconds = 0x7FFFFFFF; // "view once"
          this.viewOnceMessages.add(mongoId);
        } else if(+timer > 0) {
          media.ttl_seconds = +timer;
        }
      }
    } else if(type !== 'text' && type !== 'poll' && type !== 'system' && !text) {
      text = message.message = '[' + type + ']';
    }

    if((type === 'location' || type === 'live_location') && m.location && 'lat' in m.location) {
      media = {
        _: 'messageMediaGeo',
        geo: {_: 'geoPoint', lat: +m.location.lat || 0, long: +m.location.lng || 0, access_hash: '0'}
      };

      if(text === '[location]' || text === '[live_location]') message.message = '';
    }

    if(type === 'contact' && m.contact) {
      const contactUserId = refId(m.contact, 'userId');
      media = {
        _: 'messageMediaContact',
        phone_number: String(m.contact.phone || ''),
        first_name: String(m.contact.firstName || m.contact.name || ''),
        last_name: String(m.contact.lastName || ''),
        vcard: '',
        user_id: isMongoId(contactUserId) ? idFromMongoId(contactUserId) : 0
      };

      if(text.startsWith('[')) message.message = '';
    }

    if(type === 'game' && m.game) {
      const g = m.game;
      const shortName = String(g.short_name || 'game');
      this.gameShortNameByMsg.set(id, shortName);
      const photoUrl = jsonStr(g, 'photo_url');
      media = {
        _: 'messageMediaGame',
        game: {
          _: 'game',
          id: idForUrl('game:' + mongoId),
          access_hash: '1',
          short_name: shortName,
          title: String(g.title || shortName),
          description: String(g.description || ''),
          photo: photoUrl ? this.buildPhoto(this.absoluteUrl(photoUrl)) : {_: 'photoEmpty', id: '0'}
        }
      };

      if(message.message.startsWith('[')) message.message = '';
    }

    if(!media && !m.noLinkPreview) {
      media = this.buildWebPageMedia(m.linkPreview);
    }

    if(media) message.media = media;
    if(entities.length) {
      entities.sort((a, b) => a.offset - b.offset);
      message.entities = entities;
    }

    const replyToId = refId(m, 'replyTo');
    if(isMongoId(replyToId)) {
      const threadRootId = refId(m, 'threadRoot');
      message.reply_to = {
        _: 'messageReplyHeader',
        pFlags: {},
        reply_to_msg_id: this.rememberMessageId(replyToId)
      };

      if(isMongoId(threadRootId) && threadRootId !== replyToId) {
        message.reply_to.reply_to_top_id = this.rememberMessageId(threadRootId);
      }
    }

    // discussion-group copy of a channel post: forwarded from the channel,
    // like Telegram's automatic forwards
    const linkedPostId = refId(m, 'linkedChannelPostId');
    if(m.isChannelDiscussionAnchor && isMongoId(linkedPostId) && channelTlId !== undefined) {
      const channelMongoId = this.linkedChatMongoIdByTlId.get(channelTlId);
      if(channelMongoId) {
        const channelPeer: Peer = {_: 'peerChannel', channel_id: idFromMongoId(channelMongoId)};
        const channelPost = idFromMongoIdInt32(linkedPostId);
        message.fwd_from = {
          _: 'messageFwdHeader',
          pFlags: {},
          from_id: channelPeer,
          date: message.date,
          channel_post: channelPost,
          saved_from_peer: channelPeer,
          saved_from_msg_id: channelPost
        };
      }
    }

    // broadcast channel post: views + comments
    if(isBroadcast) {
      message.pFlags.post = true;
      message.views = Math.max(1, +m.views || 0);
      const anchorId = jsonStr(m, 'discussionAnchorId');
      const groupMongoId = this.linkedChatMongoIdByTlId.get(channelTlId);
      if(isMongoId(anchorId) && groupMongoId) {
        this.anchorMongoIdByPostTlId.set(id, anchorId);
        message.replies = {
          _: 'messageReplies',
          pFlags: {comments: true},
          replies: +m.commentsCount || 0,
          replies_pts: 0,
          channel_id: idFromMongoId(groupMongoId)
        };
      }
    }

    if(+m.ttlPeriod > 0) message.ttl_period = +m.ttlPeriod;
    if(m.isEdited) message.edit_date = parseIsoToEpochSeconds(m.updatedAt);

    if(m.replyMarkup && typeof(m.replyMarkup) === 'object') {
      const markup = this.buildReplyMarkup(m.replyMarkup);
      if(markup) message.reply_markup = markup;
    }

    this.rememberMyReaction(mongoId, m.reactions);
    // "who reacted": groups yes, channels and private chats no (as in Telegram)
    const reactions = this.buildMessageReactions(m.reactions, channelTlId !== undefined && !isBroadcast);
    if(reactions) message.reactions = reactions;

    if(m.isForwarded || 'forwardedFromName' in m) {
      const fromId = refId(m, 'forwardedFrom');
      const fromName = jsonStr(m, 'forwardedFromName');
      const fwd: Message.message['fwd_from'] = {_: 'messageFwdHeader', pFlags: {}, date: message.date};
      if(isMongoId(fromId)) {
        const fromTlId = idFromMongoId(fromId);
        this.rememberUser(fromTlId, fromId);
        fwd.from_id = {_: 'peerUser', user_id: fromTlId};
        if(m.forwardedFrom && typeof(m.forwardedFrom) === 'object' && m.forwardedFrom.name) {
          this.forwardUsers.set(fromTlId, m.forwardedFrom);
        }
      } else {
        fwd.from_name = fromName || 'Hidden user';
      }

      message.fwd_from = fwd;
    }

    const viaBotId = refId(m, 'viaBot');
    if(isMongoId(viaBotId)) {
      message.via_bot_id = idFromMongoId(viaBotId);
      this.rememberUser(+message.via_bot_id, viaBotId);
    }

    const sender = m.sender && typeof(m.sender) === 'object' ? m.sender : undefined;
    let senderId = sender ? jsonStr(sender, '_id') : jsonStr(m, 'sender');
    if(sender?.isAnonymousAdmin && channelTlId !== undefined && !isBroadcast) {
      // anonymous admin: shown as the group itself
      message.from_id = {_: 'peerChannel', channel_id: channelTlId};
      if(senderId === this.selfMongoId) message.pFlags.out = true;
      const rank = jsonStr(sender, 'rank');
      if(rank) message.post_author = rank;
      senderId = undefined;
    }

    if(senderId) {
      if(senderId === this.selfMongoId) message.pFlags.out = true;
      if(isBroadcast) {
        // channel posts are authored by the channel itself
        const signature = jsonStr(m, 'authorSignature');
        if(signature) message.post_author = signature;
      } else {
        const senderTlId = idFromMongoId(senderId);
        this.rememberUser(senderTlId, senderId);
        message.from_id = {_: 'peerUser', user_id: senderTlId};
      }
    }

    if(message.pFlags.mentioned && !message.pFlags.out && m.mentionRead === false) {
      message.pFlags.media_unread = true;
    }

    return message;
  }

  /**
   * System messages become service messages ("wallpaper changed", "X joined"),
   * everything else a normal message.
   */
  public buildAnyMessage(m: Json, peer: Peer): Message.message | Message.messageService {
    if(m.type !== 'system') {
      return this.buildMessage(m, peer);
    }

    const base = this.buildMessage(m, peer);
    const service: Message.messageService = {
      _: 'messageService',
      pFlags: base.pFlags.out ? {out: true} : {},
      id: base.id,
      peer_id: base.peer_id,
      date: base.date,
      action: {_: 'messageActionCustomAction', message: base.message || ''}
    };

    if(base.from_id) service.from_id = base.from_id;

    const action = m.systemAction;
    if(action?.type === 'set_chat_wallpaper') {
      service.action = {
        _: 'messageActionSetChatWallPaper',
        pFlags: action.forBoth ? {for_both: true} : {},
        wallpaper: this.buildWallPaper(jsonStr(action, 'url'), action.settings)
      };
    }

    return service;
  }

  public buildWallPaper(url: string, settings: Json): WallPaper {
    const wallPaperSettings: WallPaperSettings.wallPaperSettings = {
      _: 'wallPaperSettings',
      pFlags: {},
      ...(settings ? {
        intensity: +settings.intensity || 0,
        rotation: +settings.rotation || 0,
        background_color: +settings.background_color || 0,
        second_background_color: +settings.second_background_color || 0,
        third_background_color: +settings.third_background_color || 0,
        fourth_background_color: +settings.fourth_background_color || 0
      } : {})
    };

    if(settings?.blur) wallPaperSettings.pFlags.blur = true;
    if(settings?.motion) wallPaperSettings.pFlags.motion = true;

    if(!url) {
      return {
        _: 'wallPaperNoFile',
        id: String(((+settings?.background_color || 0) * 0x1000000) + (+settings?.second_background_color || 0)),
        pFlags: {},
        settings: wallPaperSettings
      };
    }

    const document = this.buildDocument(this.absoluteUrl(url), 'image/jpeg', 'wallpaper.jpg', 'file');
    return {
      _: 'wallPaper',
      id: document.id,
      pFlags: {},
      access_hash: '1',
      slug: '7e9' + String(document.id),
      document,
      settings: wallPaperSettings
    };
  }

  public messagePeerForJson(m: Json, fallback?: Peer): Peer {
    const convId = jsonStr(m, 'conversationId') || refId(m, 'conversation');
    return (convId && this.resolvePeerForConversationId(convId)) || fallback;
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------

  public newMessageUpdate(message: Message.message | Message.messageService): Update {
    if(message.peer_id._ === 'peerChannel') {
      this.ensureChannelState(+message.peer_id.channel_id);
      return {_: 'updateNewChannelMessage', message, pts: undefined, pts_count: undefined};
    }

    return {_: 'updateNewMessage', message, pts: undefined, pts_count: undefined};
  }

  public editMessageUpdate(message: Message.message | Message.messageService): Update {
    if(message.peer_id._ === 'peerChannel') {
      this.ensureChannelState(+message.peer_id.channel_id);
      return {_: 'updateEditChannelMessage', message, pts: undefined, pts_count: undefined};
    }

    return {_: 'updateEditMessage', message, pts: undefined, pts_count: undefined};
  }

  /** Feeds synthetic updates into the normal pipeline (no pts / seq checks) */
  public dispatchUpdates(updates: Update[], users: User[] = [], chats: Chat[] = []) {
    if(!updates.length && !users.length && !chats.length) return;
    for(const chat of chats) {
      if(chat._ === 'channel') this.ensureChannelState(+chat.id);
    }

    this.apiUpdatesManager.processUpdateMessage({
      _: 'updates',
      updates,
      users,
      chats,
      date: tsNow(true),
      seq: 0
    });
  }

  public affectedMessages(): MethodDeclMap['messages.deleteMessages']['res'] {
    return {_: 'messages.affectedMessages', pts: 0, pts_count: 0};
  }

  public affectedHistory(): MethodDeclMap['messages.deleteHistory']['res'] {
    return {_: 'messages.affectedHistory', pts: 0, pts_count: 0, offset: 0};
  }

  /** what the app expects back for messages this client just sent: their ids, then the messages */
  public sentMessageUpdates(sent: Json[], peer: Peer, randomIds: (string | number)[]) {
    const users: User[] = [];
    const updates: Update[] = [];
    sent.forEach((m, i) => {
      if(!m?._id) return;
      const message = this.buildAnyMessage(m, peer);
      this.addSender(m, users);
      if(randomIds[i] !== undefined) {
        updates.push({_: 'updateMessageID', id: message.id, random_id: randomIds[i]});
      }

      updates.push(this.newMessageUpdate(message));
    });

    return this.emptyUpdates(users, [], updates);
  }

  public emptyUpdates(users: User[] = [], chats: Chat[] = [], updates: Update[] = []): Updates.updates {
    return {_: 'updates', updates, users, chats, date: tsNow(true), seq: 0};
  }

  public isRestException(err: any): err is RestException {
    return err instanceof RestException;
  }

  public reactionsUpdate(peer: Peer, msgId: number, reactions: Json[]): Update.updateMessageReactions {
    const isChannel = peer._ === 'peerChannel';
    return {
      _: 'updateMessageReactions',
      peer,
      msg_id: msgId,
      reactions: this.buildMessageReactions(reactions, isChannel && !this.isBroadcast(+peer.channel_id)) || {
        _: 'messageReactions',
        pFlags: {},
        results: []
      }
    };
  }

  public pinUpdate(peer: Peer, ids: number[], pinned: boolean): Update {
    if(peer._ === 'peerChannel') {
      this.ensureChannelState(+peer.channel_id);
      return {
        _: 'updatePinnedChannelMessages',
        pFlags: pinned ? {pinned: true} : {},
        channel_id: peer.channel_id,
        messages: ids,
        pts: 0,
        pts_count: 0
      };
    }

    return {
      _: 'updatePinnedMessages',
      pFlags: pinned ? {pinned: true} : {},
      peer,
      messages: ids,
      pts: 0,
      pts_count: 0
    };
  }

  // ---------------------------------------------------------------------------
  // Realtime helpers (SocketBridge)
  // ---------------------------------------------------------------------------

  public setConnectionStatus(connected: boolean) {
    this.rootScope.dispatchEvent('connection_status_change', {
      _: 'networkerStatus',
      status: connected ? ConnectionStatus.Connected : ConnectionStatus.Connecting,
      dcId: SEVEN_NINE_DC_ID,
      name: 'NET-' + SEVEN_NINE_DC_ID,
      isFileNetworker: false,
      isFileDownload: false,
      isFileUpload: false
    });
  }

  /** after a reconnect: fetch what was sent meanwhile (see updates.getDifference) */
  public catchUp() {
    this.apiUpdatesManager.forceGetDifference();
  }

  /** server id of the newest message the app has for this peer */
  public getTopServerMessageId(peer: Peer) {
    const dialog = this.dialogsStorage.getDialogOnly(this.getPeerId(peer));
    const top = dialog?.top_message;
    return top ? this.appMessagesIdsManager.getMessageIdInfo(top).messageId : 0;
  }

  /** a conversation appeared / changed: (re)load its dialog */
  public async reloadConversation(conversationId: string) {
    const users: User[] = [], chats: Chat[] = [];
    const peer = await this.fetchAndRegisterConversation(conversationId, users, chats).catch((): Peer => undefined);
    if(!peer) return;
    this.dispatchUpdates([], users, chats);
    this.appMessagesManager.reloadConversation(this.getPeerId(peer));
  }

  /** deleted, left or removed from: drop the dialog */
  public removeConversation(conversationId: string) {
    const peer = this.resolvePeerForConversationId(conversationId);
    if(!peer) return;
    const peerId = this.getPeerId(peer);
    if(peer._ === 'peerChannel') {
      const chat = this.appChatsManager.getChat(peer.channel_id) as Chat.channel;
      if(chat?._ === 'channel') {
        this.appChatsManager.saveApiChats([{...chat, pFlags: {...chat.pFlags, left: true}}], true);
        this.dispatchUpdates([{_: 'updateChannel', channel_id: peer.channel_id}]);
      }
    }

    this.dialogsStorage.dropDialogOnDeletion(peerId);
  }

  /** "user_updated": partial payloads must not wipe what is already known */
  public applyUserUpdate(userJson: Json) {
    const fresh = this.buildUser(userJson);
    const known = this.appUsersManager.getUser(fresh.id) as User.user;
    if(known?._ === 'user') {
      if(!fresh.phone && known.phone) fresh.phone = known.phone;
      if(!('isOnline' in userJson) && !('lastSeen' in userJson) && known.status) fresh.status = known.status;
      if(!('username' in userJson)) {
        if(known.username) fresh.username = known.username;
        if(known.usernames) fresh.usernames = known.usernames;
      }

      if(!('avatar' in userJson) && known.photo) fresh.photo = known.photo;
      if(!('emojiStatus' in userJson) && known.emoji_status) fresh.emoji_status = known.emoji_status;
      if(known.pFlags.contact) fresh.pFlags.contact = true;
      if(known.pFlags.mutual_contact) fresh.pFlags.mutual_contact = true;
    }

    this.appUsersManager.saveApiUser(fresh, true);
  }

  /** a gift was given / removed on a profile: refresh its gift shelf */
  public onGiftsChanged(data: Json) {
    const userId = jsonStr(data, 'userId');
    if(!isMongoId(userId)) return;
    this.rootScope.dispatchEvent('star_gift_list_update', {peerId: idFromMongoId(userId).toPeerId(false)});
  }
}

export default RestBridge;
