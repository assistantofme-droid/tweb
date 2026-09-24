/*
 * Config, lang pack, countries, colors, update state and other app-level
 * requests the backend has no notion of: answered locally.
 */

import type {HelpPeerColorOption, HelpTimezonesList} from '@layer';
import type {BridgeHandlers, RestBridge} from '@lib/sevenNine/restBridge';
import tsNow from '@helpers/tsNow';
import {SEVEN_NINE_DC_ID, SEVEN_NINE_ORIGIN} from '@lib/sevenNine/config';
import {REACTIONS} from '@lib/sevenNine/restBridge';

const NAME_COLORS: number[][] = [
  [0xE17076], [0xFAA74A], [0xA695E7], [0x7BC862], [0x6EC9CB], [0x65AADD], [0xEE7AAE],
  [0xE15052, 0xF9AE63], [0xE0802B, 0xFAC534], [0xA05FF3, 0xF48FFF], [0x27A910, 0xA7DC57],
  [0x27ACCE, 0x82E8D6], [0x3391D4, 0x7DD3F0], [0xDD4371, 0xFFBE9F], [0x10B981, 0x6EE7B7]
];

// palette, background gradient, story ring
const PROFILE_COLORS: number[][][] = [
  [[0xBA5650], [0xC9565D, 0xD97C57], [0xCF7244, 0xCC9433]],
  [[0xC27C3E], [0xCF7244, 0xCC9433], [0xD58E3B, 0xE4B43A]],
  [[0x956AC8], [0x9662D4, 0xB966B6], [0x9B66DC, 0xC766AB]],
  [[0x49A355], [0x3D9755, 0x89A650], [0x3FAB64, 0x9BB553]],
  [[0x3E97AD], [0x3D95BA, 0x50AD98], [0x3AA4C4, 0x5DBF9C]],
  [[0x5A8FBB], [0x538BC2, 0x4DA8BD], [0x5494D4, 0x52B5CB]],
  [[0xB85378], [0xB04F74, 0xD1666D], [0xC05D83, 0xE07A6E]],
  [[0x10B981], [0x0E9F6E, 0x34D399], [0x10B981, 0x6EE7B7]]
];

const APP_CONFIG = {
  dialog_filters_enabled: true,
  dialog_filters_tooltip: false,
  autoarchive_setting_available: true,
  pending_suggestions: [] as string[],
  chatlists_joined_limit_default: 2,
  chatlists_joined_limit_premium: 20,
  chatlist_invites_limit_default: 3,
  chatlist_invites_limit_premium: 20,
  chatlist_update_period: 3600,
  reactions_uniq_max: 11,
  channels_limit_default: 500,
  channels_limit_premium: 1000,
  saved_gifs_limit_default: 200,
  saved_gifs_limit_premium: 400,
  stickers_faved_limit_default: 5,
  stickers_faved_limit_premium: 10,
  dialog_filters_limit_default: 10,
  dialog_filters_limit_premium: 30,
  dialog_filters_chats_limit_default: 100,
  dialog_filters_chats_limit_premium: 200,
  dialogs_pinned_limit_default: 5,
  dialogs_pinned_limit_premium: 10,
  dialogs_folder_pinned_limit_default: 100,
  dialogs_folder_pinned_limit_premium: 200,
  channels_public_limit_default: 10,
  channels_public_limit_premium: 20,
  caption_length_limit_default: 1024,
  caption_length_limit_premium: 4096,
  upload_max_fileparts_default: 4000,
  upload_max_fileparts_premium: 8000,
  about_length_limit_default: 70,
  about_length_limit_premium: 140,
  reactions_user_max_default: 1,
  reactions_user_max_premium: 1,
  reactions_in_chat_max: 100,
  topics_pinned_limit: 5,
  quote_length_max: 1024,
  recommended_channels_limit_default: 10,
  recommended_channels_limit_premium: 100,
  saved_dialogs_pinned_limit_default: 5,
  saved_dialogs_pinned_limit_premium: 100,
  stories_posting: 'enabled',
  stories_all_hidden: false,
  stories_stealth_cooldown_period: 3600,
  stories_stealth_future_period: 1500,
  stories_stealth_past_period: 300,
  stars_purchase_blocked: true,
  premium_purchase_blocked: true,
  stargifts_blocked: true,
  stars_gifts_enabled: false,
  giveaway_gifts_purchase_available: false,
  translations_auto_enabled: 'disabled',
  translations_manual_enabled: 'disabled',
  message_animated_emoji_max: 100,
  hidden_members_group_size_min: 100,
  forum_upgrade_participants_min: 200,
  whitelisted_domains: [new URL(SEVEN_NINE_ORIGIN).host],
  autologin_domains: [] as string[],
  url_auth_domains: [] as string[],
  ignore_restriction_reasons: [] as string[],
  phone_country_iso2: 'IR',
  poll_answers_max: 10,
  todo_items_max: 30,
  todo_item_length_max: 64,
  todo_title_length_max: 32
};

function timezoneOffset(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const get = (type: string) => +parts.find((p) => p.type === type)?.value;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 1000);
}

function buildTimezones(): HelpTimezonesList.helpTimezonesList {
  const ids: string[] = (Intl as any).supportedValuesOf?.('timeZone') || [Intl.DateTimeFormat().resolvedOptions().timeZone];
  const now = new Date();
  const timezones: HelpTimezonesList.helpTimezonesList['timezones'] = [];
  for(const id of ids) {
    if(!id.includes('/') || id.startsWith('Etc/')) continue;
    try {
      timezones.push({
        _: 'timezone',
        id,
        name: id.slice(id.lastIndexOf('/') + 1).replace(/_/g, ' '),
        utc_offset: timezoneOffset(id, now)
      });
    } catch(err) {}
  }

  return {_: 'help.timezonesList', timezones, hash: timezones.length};
}

function buildPeerColors(profile: boolean) {
  const colors: HelpPeerColorOption[] = [];
  const count = profile ? PROFILE_COLORS.length : NAME_COLORS.length;
  for(let id = 0; id < count; ++id) {
    const set: HelpPeerColorOption.helpPeerColorOption['colors'] = profile ? {
      _: 'help.peerColorProfileSet',
      palette_colors: PROFILE_COLORS[id][0],
      bg_colors: PROFILE_COLORS[id][1],
      story_colors: PROFILE_COLORS[id][2]
    } : {
      _: 'help.peerColorSet',
      colors: NAME_COLORS[id]
    };

    colors.push({
      _: 'help.peerColorOption',
      pFlags: {},
      color_id: id,
      colors: set,
      dark_colors: set,
      channel_min_level: 0,
      group_min_level: 0
    });
  }

  return {_: 'help.peerColors' as const, hash: profile ? 7902 : 7901, colors};
}

export default function systemHandlers(b: RestBridge): BridgeHandlers {
  return {
    'help.getConfig': () => {
      const now = tsNow(true);
      return {
        _: 'config',
        pFlags: {},
        date: now,
        expires: now + 3600,
        test_mode: false,
        this_dc: SEVEN_NINE_DC_ID,
        dc_options: [],
        dc_txt_domain_name: '',
        chat_size_max: 200000,
        megagroup_size_max: 200000,
        forwarded_count_max: 100,
        online_update_period_ms: 210000,
        offline_blur_timeout_ms: 5000,
        offline_idle_timeout_ms: 30000,
        online_cloud_timeout_ms: 300000,
        notify_cloud_delay_ms: 30000,
        notify_default_delay_ms: 1500,
        push_chat_period_ms: 60000,
        push_chat_limit: 2,
        edit_time_limit: 172800,
        revoke_time_limit: 2147483647,
        revoke_pm_time_limit: 2147483647,
        rating_e_decay: 2419200,
        stickers_recent_limit: 200,
        channels_read_media_period: 604800,
        call_receive_timeout_ms: 20000,
        call_ring_timeout_ms: 90000,
        call_connect_timeout_ms: 30000,
        call_packet_timeout_ms: 10000,
        me_url_prefix: SEVEN_NINE_ORIGIN + '/',
        caption_length_max: 4096,
        message_length_max: 4096,
        webfile_dc_id: SEVEN_NINE_DC_ID,
        reactions_default: {_: 'reactionEmoji', emoticon: REACTIONS[0][0]}
      };
    },

    'help.getAppConfig': () => ({
      _: 'help.appConfig',
      hash: 7979,
      config: {...APP_CONFIG} as any
    }),

    'help.getNearestDc': () => ({
      _: 'nearestDc',
      country: 'IR',
      this_dc: SEVEN_NINE_DC_ID,
      nearest_dc: SEVEN_NINE_DC_ID
    }),

    // this deployment is Iran-only (as in the Android client)
    'help.getCountriesList': () => ({
      _: 'help.countriesList',
      hash: 98,
      countries: [{
        _: 'help.country',
        pFlags: {},
        iso2: 'IR',
        default_name: 'Iran',
        name: 'Iran',
        country_codes: [{
          _: 'help.countryCode',
          country_code: '98',
          patterns: ['XXX XXX XXXX']
        }]
      }]
    }),

    'help.getTimezonesList': () => buildTimezones(),
    'help.getPeerColors': () => buildPeerColors(false),
    'help.getPeerProfileColors': () => buildPeerColors(true),
    'help.getPromoData': () => ({_: 'help.promoDataEmpty', expires: tsNow(true) + 3600}),
    'help.dismissSuggestion': () => true,

    // strings come from the app's own bundled lang pack
    'langpack.getLangPack': ({lang_code}) => ({
      _: 'langPackDifference',
      lang_code,
      from_version: 0,
      version: 1,
      strings: []
    }),
    'langpack.getDifference': ({lang_code, from_version}) => ({
      _: 'langPackDifference',
      lang_code,
      from_version,
      version: Math.max(1, from_version),
      strings: []
    }),
    'langpack.getStrings': () => [],
    'langpack.getLanguages': () => [{
      _: 'langPackLanguage',
      pFlags: {},
      name: 'English',
      native_name: 'English',
      lang_code: 'en',
      plural_code: 'en',
      strings_count: 1,
      translated_count: 1,
      translations_url: ''
    }],

    // Everything realtime arrives over Socket.IO: there is no pts log. The
    // state is just "now"; getDifference catches up after a reconnect.
    'updates.getState': () => ({
      _: 'updates.state',
      pts: 1,
      qts: 0,
      date: tsNow(true),
      seq: 0,
      unread_count: 0
    }),
    'updates.getChannelDifference': ({pts}) => ({
      _: 'updates.channelDifferenceEmpty',
      pFlags: {final: true},
      pts: pts || 1,
      timeout: 30
    }),

    'account.updateStatus': ({offline}) => {
      b.socket.emit(offline ? 'user_offline' : 'user_online', {userId: b.selfMongoId});
      return true;
    },
    'account.registerDevice': () => true,
    'account.unregisterDevice': () => true,
    'account.updateDeviceLocked': () => true,
    'account.getThemes': () => ({_: 'account.themes', hash: 1, themes: []}),
    'account.getWallPapers': () => ({_: 'account.wallPapers', hash: 1, wallpapers: []}),
    'account.getWebAuthorizations': () => ({_: 'account.webAuthorizations', authorizations: [], users: []}),
    'account.resetWebAuthorizations': () => true,
    'account.getContactSignUpNotification': () => false,
    'account.setContactSignUpNotification': () => true,
    'account.getConnectedBots': () => ({_: 'account.connectedBots', connected_bots: [], users: []}),
    'account.getPasskeys': () => ({_: 'account.passkeys', passkeys: []}),
    'account.getPassword': () => ({
      _: 'account.password',
      pFlags: {},
      new_algo: {_: 'passwordKdfAlgoUnknown'},
      new_secure_algo: {_: 'securePasswordKdfAlgoUnknown'},
      secure_random: new Uint8Array(0)
    }),

    'messages.getAvailableReactions': () => b.buildAvailableReactions(),
    'messages.getAvailableEffects': () => ({_: 'messages.availableEffects', hash: 1, effects: [], documents: []}),
    'messages.getAttachMenuBots': () => ({_: 'attachMenuBots', hash: 1, bots: [], users: []}),
    'messages.getRecentReactions': () => ({_: 'messages.reactions', hash: 1, reactions: []}),
    'messages.getSavedReactionTags': () => ({_: 'messages.savedReactionTags', hash: 1, tags: []}),
    'messages.getSuggestedDialogFilters': () => [],
    'messages.getPaidReactionPrivacy': () => b.emptyUpdates(),
    'messages.receivedMessages': () => [],
    'messages.reportReadMetrics': () => true,
    'messages.reportMusicListen': () => true,

    'premium.getMyBoosts': () => ({_: 'premium.myBoosts', my_boosts: [], chats: [], users: []}),
    'premium.getBoostsList': () => ({_: 'premium.boostsList', pFlags: {}, count: 0, boosts: [], users: []}),
    'payments.getStarsStatus': () => ({
      _: 'payments.starsStatus',
      pFlags: {},
      balance: {_: 'starsAmount', amount: 0, nanos: 0},
      chats: [],
      users: []
    }),
    'contacts.getSponsoredPeers': () => ({_: 'contacts.sponsoredPeersEmpty'}),
    'contacts.getBirthdays': () => ({_: 'contacts.contactBirthdays', contacts: [], users: []}),
    'chatlists.getChatlistUpdates': () => ({_: 'chatlists.chatlistUpdates', missing_peers: [], chats: [], users: []}),
    'stories.getAlbums': () => ({_: 'stories.albums', hash: 1, albums: []}),
    'communities.getJoinedCommunities': () => ({_: 'communities.joinedCommunities', communities: [], chats: [], users: []} as any)
  };
}
