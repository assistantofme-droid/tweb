/*
 * Sticker packs, custom emoji, saved GIFs and emoji keywords.
 *
 *   GET  /stickers/sets              the packs I have (made or saved)
 *   GET  /stickers?setId=            a pack's stickers
 *   POST /stickers/sets/:id/save     install / unsave: uninstall
 *   POST /stickers/sets              create a pack, POST /stickers/by-url adds one
 *   GET  /gifs, POST /gifs/save-by-url
 *   GET  /emoji-keywords/:lang?from=
 *
 * The same packs double as custom emoji packs, under a second set of ids.
 */

import type {
  Document,
  DocumentAttribute,
  InputStickerSet,
  InputStickerSetItem,
  MessagesStickerSet,
  StickerSet
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import {RestException, tlError} from '@lib/sevenNine/errors';
import {idFromMongoId} from '@lib/sevenNine/ids';
import {jsonStr, refId} from '@lib/sevenNine/restBridge';

// emoji packs get their own ids next to the sticker ones (still safe integers)
const EMOJI_SET_OFFSET = 2 ** 52;

type SetMeta = {mongoId: string, title: string, shortName: string, creator: boolean};

export default function stickersHandlers(b: RestBridge): BridgeHandlers {
  const setsById: Map<number, SetMeta> = new Map();

  const loadSets = async(): Promise<Json[]> => {
    const sets = await b.http.requestArray('GET', '/stickers/sets');
    for(const s of sets) {
      const mongoId = String(s._id);
      const meta: SetMeta = {
        mongoId,
        title: jsonStr(s, 'title') || 'Stickers',
        shortName: jsonStr(s, 'shortName') || mongoId,
        // my own packs: the app shows "add sticker" / edit for them
        creator: !!b.selfMongoId && b.selfMongoId === refId(s, 'creator')
      };
      const tlId = idFromMongoId(mongoId);
      setsById.set(tlId, meta);
      setsById.set(tlId + EMOJI_SET_OFFSET, meta);
    }

    return sets;
  };

  const isEmojiSetId = (id: number) => id >= EMOJI_SET_OFFSET;

  const buildSet = (tlId: number, meta: SetMeta, count = 0): StickerSet.stickerSet => {
    const emojis = isEmojiSetId(tlId);
    return {
      _: 'stickerSet',
      pFlags: {
        ...(emojis ? {emojis: true as const} : {}),
        ...(meta.creator ? {creator: true as const} : {})
      },
      installed_date: 1,
      id: tlId,
      access_hash: 1,
      title: meta.title,
      short_name: emojis ? meta.shortName + '_emoji' : meta.shortName,
      count,
      hash: 0
    };
  };

  const withAttribute = (doc: Document.document, replace: (a: DocumentAttribute) => boolean, add: DocumentAttribute) => {
    doc.attributes = doc.attributes.filter((a) => !replace(a));
    doc.attributes.push(add);
    return doc;
  };

  const buildCustomEmojiDocument = (url: string, set?: StickerSet.stickerSet) => {
    const doc = b.buildDocument(url, 'image/webp', null, 'sticker');
    return withAttribute(doc, (a) => a._ === 'documentAttributeSticker', {
      _: 'documentAttributeCustomEmoji',
      pFlags: {free: true},
      alt: '🙂',
      stickerset: set ? {_: 'inputStickerSetID', id: set.id, access_hash: set.access_hash} : {_: 'inputStickerSetEmpty'}
    });
  };

  const buildStickerDocument = (url: string, set: StickerSet.stickerSet, emoji?: string) => {
    if(set.pFlags.emojis) {
      return buildCustomEmojiDocument(url, set);
    }

    const doc = b.buildDocument(url, 'image/webp', null, 'sticker');
    return withAttribute(doc, (a) => a._ === 'documentAttributeSticker', {
      _: 'documentAttributeSticker',
      pFlags: {},
      alt: emoji || '',
      stickerset: {_: 'inputStickerSetID', id: set.id, access_hash: set.access_hash}
    });
  };

  const resolveSet = async(input: InputStickerSet): Promise<[number, SetMeta]> => {
    const find = (): [number, SetMeta] => {
      if(input._ === 'inputStickerSetID') {
        const meta = setsById.get(+input.id);
        return meta ? [+input.id, meta] : undefined;
      }

      if(input._ === 'inputStickerSetShortName') {
        const name = input.short_name.toLowerCase();
        for(const [tlId, meta] of setsById) {
          const shortName = (isEmojiSetId(tlId) ? meta.shortName + '_emoji' : meta.shortName).toLowerCase();
          if(shortName === name) return [tlId, meta];
        }
      }
    };

    if(input._ !== 'inputStickerSetID' && input._ !== 'inputStickerSetShortName') {
      // Telegram's built-in packs (animated emoji, dice, premium gifts...)
      throw tlError(400, 'STICKERSET_INVALID');
    }

    let found = find();
    if(!found) {
      await loadSets();
      found = find();
    }

    if(!found) {
      throw tlError(400, 'STICKERSET_INVALID');
    }

    return found;
  };

  const stickerSetResult = async(tlId: number, meta: SetMeta): Promise<MessagesStickerSet.messagesStickerSet> => {
    const stickers = await b.http.requestArray('GET', '/stickers?setId=' + meta.mongoId);
    const set = buildSet(tlId, meta, stickers.length);
    const documents: Document[] = [];
    for(const sticker of stickers) {
      const url = jsonStr(sticker, 'url');
      if(!url) continue;
      documents.push(buildStickerDocument(b.absoluteUrl(url), set, jsonStr(sticker, 'emoji')));
    }

    set.count = documents.length;
    const firstDoc = documents[0] as Document.document;
    if(firstDoc) set.thumb_document_id = firstDoc.id;
    return {_: 'messages.stickerSet', set, packs: [], keywords: [], documents};
  };

  const allSets = async(emojis: boolean) => {
    const sets = await loadSets().catch((): Json[] => []);
    return {
      _: 'messages.allStickers' as const,
      hash: 0,
      sets: sets.map((s) => {
        const tlId = idFromMongoId(String(s._id)) + (emojis ? EMOJI_SET_OFFSET : 0);
        return buildSet(tlId, setsById.get(tlId));
      })
    };
  };

  const toggleSet = async(input: InputStickerSet, install: boolean) => {
    try {
      const [, meta] = await resolveSet(input);
      await b.http.request('POST', '/stickers/sets/' + meta.mongoId + (install ? '/save' : '/unsave'), {});
    } catch(err) {}
  };

  const addStickerItems = async(setMongoId: string, items: InputStickerSetItem[]) => {
    for(const item of items) {
      const document = item?.document;
      const url = document && document._ === 'inputDocument' ? b.getMediaUrl(document.id) : undefined;
      const path = url && b.relativeUploadPath(url);
      if(!path) continue;
      await b.http.request('POST', '/stickers/by-url', {
        setId: setMongoId,
        fileUrl: path,
        name: item.emoji || 'Sticker'
      });
    }
  };

  const emojiKeywords = async(langCode: string, fromVersion: number) => {
    const lang = langCode || 'en';
    const result = {
      _: 'emojiKeywordsDifference' as const,
      lang_code: lang,
      from_version: fromVersion,
      version: Math.max(fromVersion, 1),
      keywords: [] as {_: 'emojiKeyword', keyword: string, emoticons: string[]}[]
    };

    try {
      const data = await b.http.request('GET', '/emoji-keywords/' + encodeURIComponent(lang) + '?from=' + fromVersion);
      result.lang_code = jsonStr(data, 'langCode') || lang;
      result.version = +data.version || result.version;
      for(const k of (data.keywords || []) as Json[]) {
        const emoticons: string[] = (k.e || []).map(String);
        if(!emoticons.length) continue;
        result.keywords.push({_: 'emojiKeyword', keyword: String(k.k || ''), emoticons});
      }
    } catch(err) {}

    return result;
  };

  return {
    'messages.getAllStickers': () => allSets(false),
    'messages.getEmojiStickers': () => allSets(true),
    'messages.getMaskStickers': () => ({_: 'messages.allStickers', hash: 0, sets: []}),

    'messages.getStickerSet': async({stickerset}) => {
      const [tlId, meta] = await resolveSet(stickerset);
      return stickerSetResult(tlId, meta);
    },

    'messages.installStickerSet': async({stickerset}) => {
      await toggleSet(stickerset, true);
      return {_: 'messages.stickerSetInstallResultSuccess'};
    },

    'messages.uninstallStickerSet': async({stickerset}) => {
      await toggleSet(stickerset, false);
      return true;
    },

    'messages.reorderStickerSets': () => true,
    'messages.getStickers': () => ({_: 'messages.stickers', hash: 0, stickers: []}),
    'messages.getRecentStickers': () => ({_: 'messages.recentStickers', hash: 0, packs: [], stickers: [], dates: []}),
    'messages.saveRecentSticker': () => true,
    'messages.clearRecentStickers': () => true,
    'messages.getFavedStickers': () => ({_: 'messages.favedStickers', hash: 0, packs: [], stickers: []}),
    'messages.faveSticker': () => true,
    'messages.getFeaturedStickers': () => ({_: 'messages.featuredStickers', pFlags: {}, hash: 0, count: 0, sets: [], unread: []}),
    'messages.getFeaturedEmojiStickers': () => ({_: 'messages.featuredStickers', pFlags: {}, hash: 0, count: 0, sets: [], unread: []}),
    'messages.readFeaturedStickers': () => true,
    'messages.getArchivedStickers': () => ({_: 'messages.archivedStickers', count: 0, sets: []}),

    // one document per id, in order: the app pairs them up by index
    'messages.getCustomEmojiDocuments': ({document_id}) => {
      return document_id.map((id): Document => {
        const url = b.getMediaUrl(id);
        return url ? buildCustomEmojiDocument(url) : {_: 'documentEmpty', id};
      });
    },

    'stickers.createStickerSet': async({title, short_name, stickers}) => {
      let setMongoId: string;
      try {
        const set = await b.http.request('POST', '/stickers/sets', {title, shortName: short_name, isPublic: true});
        setMongoId = String(set._id);
        await addStickerItems(setMongoId, stickers);
      } catch(err) {
        if(err instanceof RestException) {
          throw tlError(400, (err.serverMessage || '').includes('taken') ? 'SHORTNAME_OCCUPY_FAILED' : 'STICKERSET_INVALID');
        }

        throw err;
      }

      const tlId = idFromMongoId(setMongoId);
      const meta: SetMeta = {mongoId: setMongoId, title, shortName: short_name, creator: true};
      setsById.set(tlId, meta);
      setsById.set(tlId + EMOJI_SET_OFFSET, meta);
      return stickerSetResult(tlId, meta);
    },

    'stickers.addStickerToSet': async({stickerset, sticker}) => {
      const [tlId, meta] = await resolveSet(stickerset);
      await addStickerItems(meta.mongoId, [sticker]);
      return stickerSetResult(tlId, meta);
    },

    'stickers.checkShortName': () => true,

    'stickers.suggestShortName': ({title}) => {
      const base = (title || '').replace(/[^A-Za-z0-9_]/g, '');
      return {
        _: 'stickers.suggestedShortName',
        short_name: (base || 'stickers') + '_' + (Date.now() % 100000).toString(36)
      };
    },

    // ---------------------------------------------------------------- GIFs
    'messages.getSavedGifs': async() => {
      const gifs = await b.http.requestArray('GET', '/gifs');
      const documents: Document[] = [];
      for(const g of gifs) {
        const url = jsonStr(g, 'fileUrl');
        if(url) documents.push(b.buildDocument(b.absoluteUrl(url), 'video/mp4', null, 'gif'));
      }

      return {_: 'messages.savedGifs', hash: 0, gifs: documents};
    },

    'messages.saveGif': async({id, unsave}) => {
      const url = id?._ === 'inputDocument' ? b.getMediaUrl(id.id) : undefined;
      const path = url && b.relativeUploadPath(url);
      if(!path) {
        throw tlError(400, 'GIF_ID_INVALID');
      }

      await b.http.request('POST', '/gifs/save-by-url', {fileUrl: path, unsave: !!unsave});
      return true;
    },

    // ---------------------------------------------------------------- emoji keywords
    'messages.getEmojiKeywords': ({lang_code}) => emojiKeywords(lang_code, 0),
    'messages.getEmojiKeywordsDifference': ({lang_code, from_version}) => emojiKeywords(lang_code, from_version),
    'messages.getEmojiKeywordsLanguages': () => []
  };
}
