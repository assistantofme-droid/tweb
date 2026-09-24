/*
 * "Privacy and Security": privacy rules with their exceptions, global
 * privacy, account / history TTLs and content settings; wallpapers.
 *
 * The backend keeps one "Everyone" / "My Contacts" / "Nobody" value per
 * key plus allow / deny user lists: GET /settings, PUT /settings/privacy.
 */

import type {
  AccountPrivacyRules,
  GlobalPrivacySettings,
  InputPrivacyKey,
  InputPrivacyRule,
  PrivacyRule,
  WallPaperSettings
} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import {tlError} from '@lib/sevenNine/errors';
import {idFromMongoId, isMongoId} from '@lib/sevenNine/ids';
import {EXTENSION_BY_MIME} from '@lib/sevenNine/handlers/files';

const PRIVACY_FIELDS: {[key in InputPrivacyKey['_']]?: string} = {
  inputPrivacyKeyStatusTimestamp: 'lastSeen',
  inputPrivacyKeyPhoneNumber: 'phoneNumber',
  inputPrivacyKeyForwards: 'forwardedMessages',
  inputPrivacyKeyChatInvite: 'groupsAndChannels',
  inputPrivacyKeyProfilePhoto: 'profilePhoto',
  inputPrivacyKeyPhoneCall: 'calls',
  inputPrivacyKeyAbout: 'bio',
  inputPrivacyKeyBirthday: 'birthday',
  inputPrivacyKeyVoiceMessages: 'voiceMessages',
  inputPrivacyKeyStarGiftsAutoSave: 'gifts',
  inputPrivacyKeyAddedByPhone: 'findByPhone',
  inputPrivacyKeyPhoneP2P: 'callsP2P'
};

function privacyRuleForValue(value: string): PrivacyRule {
  if(value === 'Nobody') return {_: 'privacyValueDisallowAll'};
  if(value === 'My Contacts') return {_: 'privacyValueAllowContacts'};
  return {_: 'privacyValueAllowAll'};
}

function globalPrivacyFrom(settings: Json): GlobalPrivacySettings.globalPrivacySettings {
  const g: Json = settings.globalPrivacy || {};
  const pFlags: GlobalPrivacySettings.globalPrivacySettings['pFlags'] = {};
  if(g.archiveNonContacts) pFlags.archive_and_mute_new_noncontact_peers = true;
  if(g.keepArchivedUnmuted) pFlags.keep_archived_unmuted = true;
  if(g.keepArchivedFolders) pFlags.keep_archived_folders = true;
  if(g.hideReadMarks) pFlags.hide_read_marks = true;
  if(g.noncontactRequirePremium) pFlags.new_noncontact_peers_require_premium = true;
  return {_: 'globalPrivacySettings', pFlags};
}

function wallPaperSettingsToJson(settings: WallPaperSettings): Json {
  if(!settings) return {};
  return {
    blur: !!settings.pFlags?.blur,
    motion: !!settings.pFlags?.motion,
    intensity: settings.intensity || 0,
    rotation: settings.rotation || 0,
    background_color: settings.background_color || 0,
    second_background_color: settings.second_background_color || 0,
    third_background_color: settings.third_background_color || 0,
    fourth_background_color: settings.fourth_background_color || 0
  };
}

export default function settingsHandlers(b: RestBridge): BridgeHandlers {
  const readSettings = (): Promise<Json> => b.http.request('GET', '/settings');
  const putSettings = (body: Json) => b.http.request('PUT', '/settings', body);

  const getPrivacy = async(key: InputPrivacyKey): Promise<AccountPrivacyRules.accountPrivacyRules> => {
    const field = PRIVACY_FIELDS[key._];
    const settings = await readSettings();
    const value = field && settings.privacySettings?.[field] || 'Everyone';
    const result: AccountPrivacyRules.accountPrivacyRules = {
      _: 'account.privacyRules',
      rules: [],
      chats: [],
      users: []
    };

    const exceptions: Json = field && settings.privacyExceptions?.[field];
    const people: Map<string, Json> = new Map();
    for(const u of (settings.exceptionUsers || []) as Json[]) {
      people.set(String(u._id), u);
    }

    if(exceptions) {
      for(const kind of ['allow', 'deny'] as const) {
        const ids: number[] = [];
        for(const raw of (exceptions[kind] || []) as any[]) {
          const uid = String(raw);
          if(!isMongoId(uid)) continue;
          const tlId = idFromMongoId(uid);
          ids.push(tlId);
          b.rememberUser(tlId, uid);
          const u = people.get(uid);
          if(u) b.addUserOnce(result.users, b.buildUser(u));
        }

        if(ids.length) {
          result.rules.push(kind === 'allow' ?
            {_: 'privacyValueAllowUsers', users: ids} :
            {_: 'privacyValueDisallowUsers', users: ids});
        }
      }
    }

    result.rules.push(privacyRuleForValue(value));
    return result;
  };

  const addInputUsers = (out: string[], users: any[]) => {
    for(const u of users || []) {
      const id = b.userMongoIdOf(u);
      if(id) out.push(id);
    }
  };

  // "Add users or groups" in the exceptions: a group expands to its members
  const addChatMembers = async(out: string[], chats: (string | number)[]) => {
    for(const chatId of chats || []) {
      const convId = b.chatConversationIdOf(+chatId);
      if(!convId) continue;
      try {
        const conv = await b.http.request('GET', '/conversations/' + convId);
        for(const p of (conv.participants || []) as any[]) {
          const id = p && typeof(p) === 'object' ? String(p._id) : String(p);
          if(isMongoId(id) && id !== b.selfMongoId) out.push(id);
        }
      } catch(err) {}
    }
  };

  return {
    'account.getPrivacy': ({key}) => getPrivacy(key),

    'account.setPrivacy': async({key, rules}) => {
      const field = PRIVACY_FIELDS[key._];
      if(!field) {
        return {_: 'account.privacyRules', rules: [privacyRuleForValue('Everyone')], chats: [], users: []};
      }

      let value = 'Everyone';
      const allow: string[] = [];
      const deny: string[] = [];
      for(const rule of rules as InputPrivacyRule[]) {
        switch(rule._) {
          case 'inputPrivacyValueDisallowAll': value = 'Nobody'; break;
          case 'inputPrivacyValueAllowContacts':
          case 'inputPrivacyValueAllowCloseFriends': value = 'My Contacts'; break;
          case 'inputPrivacyValueAllowAll': value = 'Everyone'; break;
          case 'inputPrivacyValueAllowUsers': addInputUsers(allow, rule.users); break;
          case 'inputPrivacyValueDisallowUsers': addInputUsers(deny, rule.users); break;
          case 'inputPrivacyValueAllowChatParticipants': await addChatMembers(allow, rule.chats); break;
          case 'inputPrivacyValueDisallowChatParticipants': await addChatMembers(deny, rule.chats); break;
        }
      }

      await b.http.request('PUT', '/settings/privacy', {key: field, value, allow, deny});
      return getPrivacy(key);
    },

    'account.getGlobalPrivacySettings': async() => globalPrivacyFrom(await readSettings()),

    'account.setGlobalPrivacySettings': async({settings}) => {
      const f = settings.pFlags || {};
      await putSettings({
        globalPrivacy: {
          archiveNonContacts: !!f.archive_and_mute_new_noncontact_peers,
          keepArchivedUnmuted: !!f.keep_archived_unmuted,
          keepArchivedFolders: !!f.keep_archived_folders,
          hideReadMarks: !!f.hide_read_marks,
          noncontactRequirePremium: !!f.new_noncontact_peers_require_premium
        }
      });
      return {...settings, _: 'globalPrivacySettings'};
    },

    'account.getAccountTTL': async() => {
      const settings = await readSettings();
      return {_: 'accountDaysTTL', days: +settings.accountTtlDays > 0 ? +settings.accountTtlDays : 365};
    },

    'account.setAccountTTL': async({ttl}) => {
      await putSettings({accountTtlDays: ttl.days});
      return true;
    },

    'messages.getDefaultHistoryTTL': async() => {
      const settings = await readSettings();
      return {_: 'defaultHistoryTTL', period: +settings.defaultHistoryTtl || 0};
    },

    'messages.setDefaultHistoryTTL': async({period}) => {
      await putSettings({defaultHistoryTtl: period});
      return true;
    },

    'account.getContentSettings': async() => {
      const settings = await readSettings();
      return {
        _: 'account.contentSettings',
        pFlags: {
          sensitive_can_change: true,
          ...(settings.sensitiveContent ? {sensitive_enabled: true as const} : {})
        }
      };
    },

    'account.setContentSettings': async(params) => {
      await putSettings({sensitiveContent: !!params.sensitive_enabled});
      return true;
    },

    'account.getReactionsNotifySettings': () => ({
      _: 'reactionsNotifySettings',
      messages_notify_from: {_: 'reactionNotificationsFromAll'},
      stories_notify_from: {_: 'reactionNotificationsFromAll'},
      sound: {_: 'notificationSoundDefault'},
      show_previews: true
    }),

    'account.setReactionsNotifySettings': ({settings}) => settings,

    // no chat themes on this backend: an empty list, not an error
    'account.getChatThemes': () => ({_: 'account.themes', hash: 1, themes: []}),

    'payments.clearSavedInfo': () => true,

    // ---------------------------------------------------------------- wallpapers
    'account.uploadWallPaper': async({file, mime_type, settings}) => {
      const mime = mime_type || 'image/jpeg';
      const blob = b.takeUpload(file, mime);
      const response = await b.http.requestMultipart('POST', '/messages/upload', {}, [{field: 'file', blob, fileName: 'wallpaper' + (EXTENSION_BY_MIME[mime] || '.jpg')}]);
      return b.buildWallPaper(String(response.url), wallPaperSettingsToJson(settings));
    },

    // an uploaded wallpaper is found again by its slug ("7e9" + document id)
    'account.getWallPaper': ({wallpaper}) => {
      const id = wallpaper._ === 'inputWallPaperSlug' ? wallpaper.slug.replace(/^7e9/, '') :
        wallpaper._ === 'inputWallPaper' ? String(wallpaper.id) :
        undefined;
      const url = id && b.getMediaUrl(id);
      if(!url) {
        throw tlError(400, 'WALLPAPER_INVALID');
      }

      return b.buildWallPaper(url, undefined);
    },

    'account.saveWallPaper': () => true,
    'account.installWallPaper': () => true,
    'account.resetWallPapers': () => true,

    'messages.setChatWallPaper': async({peer, wallpaper, settings, revert, for_both}) => {
      const convId = await b.requireConversationIdOf(peer);
      const url = wallpaper?._ === 'inputWallPaper' ? b.getMediaUrl(wallpaper.id) : undefined;
      const path = url && b.relativeUploadPath(url);
      // plain colour / gradient wallpapers have no file, only their colours
      const noFile = !revert && !path && settings &&
        (!wallpaper || wallpaper._ === 'inputWallPaperNoFile') &&
        !!(settings.background_color || settings.second_background_color);
      const body: Json = {};
      if(revert || (!path && !noFile)) {
        body.revert = true;
      } else {
        if(path) body.url = path;
        if(noFile) body.noFile = true;
        body.forBoth = !!for_both;
        body.settings = wallPaperSettingsToJson(settings);
      }

      const response = await b.http.request('PUT', '/conversations/' + convId + '/wallpaper', body);
      if(!response?._id) {
        return b.emptyUpdates();
      }

      return b.emptyUpdates([], [], [b.newMessageUpdate(b.buildAnyMessage(response, b.peerFromInput(peer)))]);
    }
  };
}
