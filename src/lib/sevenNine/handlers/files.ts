/*
 * File downloads (ranged HTTPS reads of the backend's static files), uploads
 * and profile photos.
 */

import type {InputFileLocation, InputPhoto, MessageMedia, Photo, UploadFile} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import tsNow from '@helpers/tsNow';
import {restError, tlError, toTlError} from '@lib/sevenNine/errors';
import {jsonStr} from '@lib/sevenNine/restBridge';

export const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/x-tgsticker': '.tgs'
};

function uploadFile(bytes: Uint8Array): UploadFile.uploadFile {
  return {_: 'upload.file', type: {_: 'storage.fileUnknown'}, mtime: tsNow(true), bytes};
}

export default function filesHandlers(b: RestBridge): BridgeHandlers {
  /** the URL of the file a location points to */
  const resolveLocation = async(location: InputFileLocation): Promise<{url: string, id: string, whole: boolean}> => {
    switch(location._) {
      case 'inputPhotoFileLocation': {
        const id = String(location.id);
        let url: string;
        if(location.thumb_size === 'u' || location.thumb_size === 'v') {
          url = b.getVideoUrlForPhoto(id); // video avatar
        }

        url ||= b.getMediaUrl(id) || b.urlFromFileReference(location.file_reference);
        return {url, id, whole: false};
      }

      case 'inputDocumentFileLocation': {
        const id = String(location.id);
        return {url: b.getMediaUrl(id) || b.urlFromFileReference(location.file_reference), id, whole: false};
      }

      case 'inputPeerPhotoFileLocation': {
        const id = String(location.photo_id);
        let url = b.getMediaUrl(id);
        if(!url) {
          // the peer's current avatar
          const userMongoId = b.userTlIdOf(location.peer) !== undefined ? b.userMongoIdOf(location.peer) : undefined;
          let json: Json;
          if(userMongoId) {
            json = await b.http.request('GET', userMongoId === b.selfMongoId ? '/auth/me' : '/auth/users/' + userMongoId).catch((): Json => undefined);
          } else {
            const convId = b.chatConversationIdOf(location.peer);
            json = convId ? await b.http.request('GET', '/messages/conversations/' + convId).catch((): Json => undefined) : undefined;
          }

          const avatar = jsonStr(json, 'avatar');
          if(avatar) url = b.absoluteUrl(avatar);
        }

        return {url, id, whole: true};
      }
    }

    return {url: undefined, id: undefined, whole: false};
  };

  const fetchBytes = async(url: string, range?: [number, number]) => {
    const response = await fetch(url, range ? {headers: {Range: `bytes=${range[0]}-${range[1]}`}} : undefined);
    if(response.status === 416) {
      // asked past the end (size was a multiple of the chunk): done
      return {status: 416, bytes: new Uint8Array(0)};
    }

    if(!response.ok) {
      throw restError(response.status, 'File fetch failed');
    }

    return {status: response.status, bytes: new Uint8Array(await response.arrayBuffer())};
  };

  // photos.uploadProfilePhoto -> PUT /auth/profile (multipart "file")
  const uploadProfilePhoto = async(params: {file?: any, video?: any}) => {
    if(!params.file && !params.video) throw tlError(400, 'PHOTO_FILE_MISSING');
    let userJson: Json;
    if(params.file) {
      const blob = b.takeUpload(params.file);
      const mime = blob.type || 'image/jpeg';
      userJson = await b.http.requestMultipart('PUT', '/auth/profile', {}, [{field: 'file', blob, fileName: 'avatar' + (EXTENSION_BY_MIME[mime] || '.jpg')}]);
    }

    if(params.video) {
      // animated profile picture (a still frame + an mp4)
      const video = b.takeUpload(params.video, 'video/mp4');
      userJson = await b.http.requestMultipart('POST', '/auth/profile-video', {}, [{field: 'file', blob: video, fileName: 'avatar.mp4'}]);
    }

    const user = b.buildUser(userJson, true);
    const avatar = jsonStr(userJson, 'avatar');
    const photo: Photo = avatar ? b.buildProfilePhoto(avatar, jsonStr(userJson, 'avatarVideo')) : {_: 'photoEmpty', id: '0'};
    return {_: 'photos.photo' as const, photo, users: [user]};
  };

  const removeProfilePhoto = async() => {
    const userJson = await b.http.request('PUT', '/auth/profile', {avatar: ''});
    return {_: 'photos.photo' as const, photo: {_: 'photoEmpty' as const, id: '0'}, users: [b.buildUser(userJson, true)]};
  };

  return {
    'upload.saveFilePart': ({file_id, file_part, bytes}) => {
      b.saveFilePart(file_id, file_part, bytes as any);
      return true;
    },

    'upload.saveBigFilePart': ({file_id, file_part, bytes}) => {
      b.saveFilePart(file_id, file_part, bytes as any);
      return true;
    },

    // ranged GET against the backend's static files (Express serves Range
    // requests, so this also streams videos and large files in chunks)
    'upload.getFile': async({location, offset, limit}) => {
      const {url, id, whole} = await resolveLocation(location);
      if(!url) {
        throw tlError(400, 'FILE_ID_INVALID');
      }

      offset = +offset || 0;
      const knownSize = id ? b.getMediaSize(id) : 0;
      // unknown size: the app downloads a single chunk, so it gets the whole file
      if(whole || (!offset && !knownSize)) {
        if(offset) return uploadFile(new Uint8Array(0));
        const {bytes} = await fetchBytes(url);
        if(id && bytes.length) b.registerMedia(url, bytes.length);
        return uploadFile(bytes);
      }

      const {status, bytes} = await fetchBytes(url, [offset, offset + limit - 1]);
      if(status === 200 && (offset > 0 || bytes.length > limit)) {
        // the server ignored Range and sent the whole file: cut the asked chunk
        return uploadFile(bytes.slice(Math.min(offset, bytes.length), Math.min(bytes.length, offset + limit)));
      }

      return uploadFile(bytes);
    },

    'upload.getWebFile': async({location, offset, limit}) => {
      const url = (location as {url?: string}).url;
      if(!url) throw tlError(400, 'LOCATION_INVALID');
      const {bytes} = await fetchBytes(url, [+offset || 0, (+offset || 0) + limit - 1]);
      return {
        _: 'upload.webFile',
        size: bytes.length,
        mime_type: '',
        file_type: {_: 'storage.fileUnknown'},
        mtime: tsNow(true),
        bytes
      };
    },

    // sticker maker etc.: POST /messages/upload -> a file URL
    'messages.uploadMedia': async({media}) => {
      const file = (media as {file?: any}).file;
      if(!file) throw tlError(400, 'MEDIA_EMPTY');
      const isPhoto = media._ === 'inputMediaUploadedPhoto';
      const mime = isPhoto ? 'image/jpeg' : ((media as {mime_type?: string}).mime_type || 'image/webp');
      const blob = b.takeUpload(file, mime);
      const response = await b.http.requestMultipart('POST', '/messages/upload', {}, [{field: 'file', blob, fileName: 'upload' + (EXTENSION_BY_MIME[mime] || '')}]);
      const url = b.absoluteUrl(String(response.url));
      const size = +response.size || blob.size;
      if(isPhoto) {
        return b.buildPhotoMedia(url, {size});
      }

      const sticker = mime === 'image/webp' || mime === 'application/x-tgsticker' || mime === 'video/webm';
      return b.buildDocumentMedia(url, mime, 'upload' + (EXTENSION_BY_MIME[mime] || ''), sticker ? 'sticker' : 'file', {size}) as MessageMedia;
    },

    'photos.uploadProfilePhoto': async(params) => {
      if(params.bot && params.bot._ !== 'inputUserEmpty') {
        if(!b.setBotPhoto) throw tlError(400, 'BOT_INVALID');
        return b.setBotPhoto(params.bot, params.file);
      }

      return uploadProfilePhoto(params).catch((err) => {
        throw toTlError(err);
      });
    },

    'photos.updateProfilePhoto': async({id, bot}) => {
      if(bot && bot._ !== 'inputUserEmpty') {
        if(!b.setBotPhoto) throw tlError(400, 'BOT_INVALID');
        return b.setBotPhoto(bot, undefined);
      }

      if(!id || (id as InputPhoto)._ === 'inputPhotoEmpty') {
        return removeProfilePhoto();
      }

      // making an older photo the current one: re-upload it from its URL
      const url = b.getMediaUrl((id as InputPhoto.inputPhoto).id) || b.urlFromFileReference((id as InputPhoto.inputPhoto).file_reference);
      const path = b.relativeUploadPath(url);
      if(!path) throw tlError(400, 'PHOTO_ID_INVALID');
      const userJson = await b.http.request('PUT', '/auth/profile', {avatar: path});
      const user = b.buildUser(userJson, true);
      const avatar = jsonStr(userJson, 'avatar');
      return {
        _: 'photos.photo',
        photo: avatar ? b.buildProfilePhoto(avatar, jsonStr(userJson, 'avatarVideo')) : {_: 'photoEmpty', id: '0'},
        users: [user]
      };
    },

    'photos.deletePhotos': async({id}) => {
      const self = b.usersManager.getSelf();
      const currentPhotoId = self?.photo?._ === 'userProfilePhoto' ? String(self.photo.photo_id) : undefined;
      const ids = id.map((photo) => String((photo as InputPhoto.inputPhoto).id));
      if(currentPhotoId && ids.includes(currentPhotoId)) {
        await removeProfilePhoto();
      }

      return ids;
    },

    'photos.getUserPhotos': async({user_id, offset, limit}) => {
      const mongoId = b.userMongoIdOf(user_id);
      if(!mongoId) return {_: 'photos.photos', photos: [], users: []};
      const userJson = await b.http.request('GET', mongoId === b.selfMongoId ? '/auth/me' : '/auth/users/' + mongoId);
      const urls: string[] = [];
      const avatar = jsonStr(userJson, 'avatar');
      if(avatar && !avatar.startsWith('data:')) urls.push(avatar);
      for(const a of Array.isArray(userJson.avatars) ? userJson.avatars : []) {
        if(a && typeof(a) === 'string' && !a.startsWith('data:') && !urls.includes(a)) urls.push(a);
      }

      const start = Math.max(0, offset || 0);
      const photos = urls.slice(start, limit ? start + limit : undefined).map((url, i) => {
        return start + i === 0 && avatar ?
          b.buildProfilePhoto(url, jsonStr(userJson, 'avatarVideo')) :
          b.buildPhoto(b.absoluteUrl(url), {w: 640, h: 640});
      });

      return {_: 'photos.photosSlice', count: urls.length, photos, users: [b.buildUser(userJson)]};
    }
  };
}
