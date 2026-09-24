/*
 * Stories and the profile gift shelf.
 *
 *   GET  /stories/me, /stories                 mine, and everyone's I can see
 *   GET  /stories/pinned?userId|conversationId  a profile's "Posted" stories
 *   GET  /stories/archive, /stories/by-ids?ids=
 *   POST /stories/:id/view, /stories/:id/pin {pinned}, DELETE /stories/:id
 *   GET  /gifts/user/:id
 */

import type {
  Chat,
  InputPeer,
  MessageMedia,
  PaymentsSavedStarGifts,
  Peer,
  PeerStories,
  SavedStarGift,
  StoryItem,
  User
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import {tlError} from '@lib/sevenNine/errors';
import {idFromMongoId, idFromMongoIdInt32, parseIsoToEpochSeconds} from '@lib/sevenNine/ids';
import {jsonStr, refId} from '@lib/sevenNine/restBridge';

export default function storiesHandlers(b: RestBridge): BridgeHandlers {
  const storyMongoIdByTlId: Map<number, string> = new Map();

  const buildStoryItem = (story: Json, out: boolean): StoryItem.storyItem => {
    const mongoId = String(story._id);
    const id = idFromMongoIdInt32(mongoId);
    storyMongoIdByTlId.set(id, mongoId);

    const meta: Json = story.mediaMeta || {};
    const size = +story.fileSize || 0;
    const thumb = jsonStr(story, 'thumb');
    const mediaUrl = b.absoluteUrl(String(story.mediaUrl));
    const media: MessageMedia = jsonStr(story, 'mediaType') === 'video' ?
      b.buildDocumentMedia(mediaUrl, 'video/mp4', null, 'video', {size, meta, thumb}) :
      b.buildPhotoMedia(mediaUrl, {w: +meta.width || undefined, h: +meta.height || undefined, size, thumb});

    const item: StoryItem.storyItem = {
      _: 'storyItem',
      pFlags: {
        ...(out ? {out: true as const} : {}),
        ...(story.pinned !== false ? {pinned: true as const} : {})
      },
      id,
      date: parseIsoToEpochSeconds(story.createdAt),
      expire_date: parseIsoToEpochSeconds(story.expiresAt),
      media
    };

    const caption = jsonStr(story, 'caption');
    if(caption) item.caption = caption;

    if(Array.isArray(story.viewers)) {
      item.views = {_: 'storyViews', pFlags: {}, views_count: story.viewers.length};
    }

    return item;
  };

  const isSelfPeer = (peer: InputPeer) => {
    return !peer || peer._ === 'inputPeerSelf' || (
      peer._ === 'inputPeerUser' && !!b.selfMongoId && +peer.user_id === idFromMongoId(b.selfMongoId)
    );
  };

  const canPostStoriesAs = (chatTlId: number) => {
    const chat = b.chatsManager.getChat(chatTlId) as Chat.channel;
    return !!chat && chat._ === 'channel' && !chat.pFlags.left && (!!chat.pFlags.creator || !!chat.admin_rights?.pFlags?.post_stories);
  };

  const storyIdsToMongo = (ids: number[]) => ids.map((id) => storyMongoIdByTlId.get(id)).filter(Boolean);

  const storyAction = async(ids: number[], method: string, suffix: string, body?: Json) => {
    const done: number[] = [];
    for(const id of ids) {
      const mongoId = storyMongoIdByTlId.get(id);
      if(!mongoId) continue;
      try {
        await b.http.request(method, '/stories/' + mongoId + suffix, body ?? (method === 'POST' ? {} : undefined));
        done.push(id);
      } catch(err) {}
    }

    return done;
  };

  // a profile's "Posted" stories, or my archive (all of them, expired too)
  const storyList = async(peer: InputPeer, offsetId: number, limit: number, archive: boolean) => {
    const result = {_: 'stories.stories' as const, count: 0, stories: [] as StoryItem[], chats: [] as Chat[], users: [] as User[]};
    let path = (archive ? '/stories/archive?' : '/stories/pinned?') + 'limit=' + Math.max(1, Math.min(limit || 100, 100));
    let mine: boolean;
    if(peer && peer._ === 'inputPeerChannel') {
      const convId = b.chatConversationIdOf(peer);
      if(!convId) return result;
      path += '&conversationId=' + convId;
      const chat = b.chatsManager.getChat(+peer.channel_id) as Chat.channel;
      mine = !!chat && (!!chat.pFlags?.creator || !!chat.admin_rights);
    } else {
      const self = isSelfPeer(peer);
      const userMongoId = self ? b.selfMongoId : b.userMongoIdOf(peer);
      if(!userMongoId) return result;
      if(!archive) path += '&userId=' + userMongoId;
      mine = self;
    }

    if(offsetId) {
      const before = storyMongoIdByTlId.get(offsetId);
      if(before) path += '&before=' + before;
    }

    try {
      const response = await b.http.request('GET', path);
      for(const story of (response.stories || []) as Json[]) {
        result.stories.push(buildStoryItem(story, mine));
      }

      result.count = +response.count || result.stories.length;
    } catch(err) {}

    return result;
  };

  const giftPicture = (g: Json) => {
    // prefer the Lottie animation, fall back to the static picture
    const isLottie = (url: string) => /\.(json|tgs)$/.test(url.toLowerCase());
    let url = jsonStr(g, 'animationUrl') || '';
    if(!isLottie(url)) url = jsonStr(g, 'thumbnailUrl') || url;
    if(!url) return;
    const lower = url.toLowerCase();
    if(isLottie(lower)) return {url, mime: 'application/x-tgsticker', fileName: 'AnimatedSticker.tgs'};
    const ext = lower.lastIndexOf('.') >= 0 ? lower.slice(lower.lastIndexOf('.')) : '.webp';
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/webp';
    return {url, mime, fileName: 'gift' + ext};
  };

  return {
    'stories.getAllStories': async({hidden}) => {
      const result = {
        _: 'stories.allStories' as const,
        pFlags: {},
        count: 0,
        state: '1',
        peer_stories: [] as PeerStories[],
        chats: [] as Chat[],
        users: [] as User[],
        stealth_mode: {_: 'storiesStealthMode' as const}
      };
      if(hidden) return result;

      const mine = await b.http.requestArray('GET', '/stories/me');
      if(mine.length && b.selfMongoId) {
        const me = await b.http.request('GET', '/auth/me');
        b.addUserOnce(result.users, b.buildUser(me, true));
        result.peer_stories.push({
          _: 'peerStories',
          peer: {_: 'peerUser', user_id: idFromMongoId(b.selfMongoId)},
          stories: mine.map((story) => buildStoryItem(story, true))
        });
      }

      const groups = await b.http.requestArray('GET', '/stories');
      for(const group of groups) {
        let peer: Peer;
        if(group.conversation) {
          // posted by a group / channel
          peer = b.registerConversationChat(group.conversation, result.chats);
        } else {
          const user = b.buildUser(group.user);
          b.addUserOnce(result.users, user);
          peer = {_: 'peerUser', user_id: user.id};
        }

        result.peer_stories.push({
          _: 'peerStories',
          peer,
          stories: ((group.stories || []) as Json[]).map((story) => buildStoryItem(story, false))
        });
      }

      result.count = result.peer_stories.length;
      return result;
    },

    'stories.getPeerStories': async({peer}) => {
      const result = {
        _: 'stories.peerStories' as const,
        stories: {_: 'peerStories' as const, peer: b.peerFromInput(peer), stories: [] as StoryItem[]},
        chats: [] as Chat[],
        users: [] as User[]
      };

      if(isSelfPeer(peer)) {
        const mine = await b.http.requestArray('GET', '/stories/me');
        result.stories.peer = {_: 'peerUser', user_id: idFromMongoId(b.selfMongoId)};
        result.stories.stories = mine.map((story) => buildStoryItem(story, true));
        return result;
      }

      const chatTlId = peer._ === 'inputPeerChannel' ? +peer.channel_id : 0;
      const userTlId = peer._ === 'inputPeerUser' ? +peer.user_id : 0;
      const groups = await b.http.requestArray('GET', '/stories');
      for(const group of groups) {
        if(group.conversation) {
          if(!chatTlId || idFromMongoId(String(group.conversation._id)) !== chatTlId) continue;
          result.stories.peer = b.registerConversationChat(group.conversation, result.chats);
        } else {
          if(!userTlId || idFromMongoId(String(group.user?._id)) !== userTlId) continue;
          b.addUserOnce(result.users, b.buildUser(group.user));
        }

        result.stories.stories = ((group.stories || []) as Json[]).map((story) => buildStoryItem(story, false));
        break;
      }

      return result;
    },

    'stories.getPinnedStories': ({peer, offset_id, limit}) => storyList(peer, offset_id, limit, false),
    'stories.getStoriesArchive': ({peer, offset_id, limit}) => storyList(peer, offset_id, limit, true),

    'stories.getStoriesByID': async({id}) => {
      const result = {_: 'stories.stories' as const, count: 0, stories: [] as StoryItem[], chats: [] as Chat[], users: [] as User[]};
      const mongoIds = storyIdsToMongo(id);
      if(!mongoIds.length) return result;
      try {
        const stories = await b.http.requestArray('GET', '/stories/by-ids?ids=' + mongoIds.join(','));
        for(const story of stories) {
          result.stories.push(buildStoryItem(story, !!b.selfMongoId && b.selfMongoId === refId(story, 'user')));
        }
      } catch(err) {}

      result.count = result.stories.length;
      return result;
    },

    'stories.deleteStories': ({id}) => storyAction(id, 'DELETE', ''),
    'stories.togglePinned': ({id, pinned}) => storyAction(id, 'POST', '/pin', {pinned: !!pinned}),

    'stories.incrementStoryViews': async({id}) => {
      await storyAction(id, 'POST', '/view');
      return true;
    },

    'stories.readStories': () => [],
    'stories.togglePinnedToTop': () => true,
    'stories.togglePeerStoriesHidden': () => true,

    'stories.canSendStory': ({peer}) => {
      // me: always; groups / channels: the owner or admins (the server checks again)
      if(peer?._ === 'inputPeerChannel' && !canPostStoriesAs(+peer.channel_id)) {
        throw tlError(403, 'CHAT_ADMIN_REQUIRED');
      }

      return {_: 'stories.canSendStoryCount', count_remains: 100};
    },

    // "post story as": the groups and channels this account can post for
    'stories.getChatsToSend': () => {
      const chats: Chat[] = [];
      for(const [chatTlId] of b.getChatConversationIds()) {
        if(canPostStoriesAs(+chatTlId)) chats.push(b.chatsManager.getChat(+chatTlId));
      }

      return {_: 'messages.chats', chats};
    },

    // ---------------------------------------------------------------- the profile gift shelf
    'payments.getSavedStarGifts': async({peer, offset}) => {
      const result: PaymentsSavedStarGifts.paymentsSavedStarGifts = {
        _: 'payments.savedStarGifts',
        count: 0,
        gifts: [],
        chats: [],
        users: []
      };

      const userMongoId = isSelfPeer(peer) ? b.selfMongoId : peer._ === 'inputPeerUser' ? b.userMongoIdOf(peer) : undefined;
      if(!userMongoId || offset) return result;

      const gifts = await b.http.requestArray('GET', '/gifts/user/' + userMongoId);
      for(const g of gifts) {
        if(g.isVisibleInProfile === false) continue;
        const picture = giftPicture(g);
        if(!picture) continue;

        const stars = +String(g.displayValue || '0').replace(/[^0-9]/g, '') || 0;
        const title = jsonStr(g, 'name');
        const saved: SavedStarGift.savedStarGift = {
          _: 'savedStarGift',
          pFlags: {},
          date: parseIsoToEpochSeconds(g.createdAt),
          gift: {
            _: 'starGift',
            pFlags: {},
            id: idFromMongoId(String(g._id)),
            sticker: b.buildDocument(b.absoluteUrl(picture.url), picture.mime, picture.fileName, 'sticker'),
            stars,
            convert_stars: stars,
            ...(title ? {title} : {})
          }
        };

        const sender: Json = g.sender;
        if(!g.isAnonymous && sender?._id) {
          const user = b.buildUser(sender);
          saved.from_id = {_: 'peerUser', user_id: user.id};
          b.addUserOnce(result.users, user);
        } else if(g.isAnonymous) {
          saved.pFlags.name_hidden = true;
        }

        const caption = jsonStr(g, 'caption');
        if(caption) saved.message = {_: 'textWithEntities', text: caption, entities: []};

        result.gifts.push(saved);
      }

      result.count = result.gifts.length;
      return result;
    }
  };
}
