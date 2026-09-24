/*
 * Login (phone + one-time code), sign up, log out and the sessions list.
 */

import type {AccountAuthorizations, Authorization} from '@layer';
import type {BridgeHandlers, Json, RestBridge} from '@lib/sevenNine/restBridge';
import {RestException, tlError} from '@lib/sevenNine/errors';
import {idForUrl, parseIsoToEpochSeconds} from '@lib/sevenNine/ids';
import {getEnvironment} from '@environment/utils';
import {SEVEN_NINE_APP_NAME} from '@lib/sevenNine/config';
import {joinName, jsonStr, normalizePhone} from '@lib/sevenNine/restBridge';

function sendCodeError(err: any) {
  if(err instanceof RestException) {
    if(err.statusCode === 429) {
      return tlError(420, 'FLOOD_WAIT_60');
    }

    return tlError(400, 'PHONE_NUMBER_INVALID', err.serverMessage);
  }

  return err;
}

function signInError(err: any) {
  if(err instanceof RestException) {
    const message = (err.serverMessage || '').toLowerCase();
    if(message.includes('expired')) return tlError(400, 'PHONE_CODE_EXPIRED');
    if(message.includes('suspend') || message.includes('banned')) return tlError(400, 'USER_DEACTIVATED_BAN');
    if(err.statusCode === 429) return tlError(420, 'FLOOD_WAIT_60');
    return tlError(400, 'PHONE_CODE_INVALID');
  }

  return err;
}

function deviceModel() {
  const ua = getEnvironment().USER_AGENT || '';
  const browser = /Edg\//.test(ua) ? 'Edge' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    'Browser';
  const os = /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' :
    '';
  return `${SEVEN_NINE_APP_NAME} Web (${browser}${os ? ', ' + os : ''})`;
}

export default function authHandlers(b: RestBridge): BridgeHandlers {
  // the backend has no phone_code_hash: one is minted here per phone number
  const pendingPhoneByHash: Map<string, string> = new Map();

  const sendCode = async(phoneNumber: string) => {
    const phone = normalizePhone(phoneNumber);
    try {
      await b.http.request('POST', '/auth/send-otp', {phone}, false);
    } catch(err) {
      throw sendCodeError(err);
    }

    const hash = 'h_' + phone + '_' + Date.now();
    pendingPhoneByHash.set(hash, phone);
    return {
      _: 'auth.sentCode' as const,
      pFlags: {},
      type: {_: 'auth.sentCodeTypeSms' as const, length: 6},
      phone_code_hash: hash
    };
  };

  return {
    'auth.sendCode': ({phone_number}) => sendCode(phone_number),
    'auth.resendCode': ({phone_number}) => sendCode(phone_number),
    'auth.cancelCode': () => true,

    'auth.signIn': async({phone_number, phone_code_hash, phone_code}) => {
      const phone = pendingPhoneByHash.get(phone_code_hash) || normalizePhone(phone_number);
      let response: Json;
      try {
        response = await b.http.request('POST', '/auth/verify-otp', {
          phone,
          code: phone_code,
          deviceModel: deviceModel(),
          deviceId: b.getDeviceId()
        }, false);
      } catch(err) {
        throw signInError(err);
      }

      const token = jsonStr(response, 'token');
      const userJson: Json = response.user;
      if(!token || !userJson?._id) {
        throw tlError(400, 'PHONE_CODE_INVALID');
      }

      await b.setSession(token, String(userJson._id));
      // brand-new account (created with an empty name): the sign-up card asks
      // for a name, which comes back as auth.signUp
      if(!String(userJson.name || '').trim()) {
        return {_: 'auth.authorizationSignUpRequired', pFlags: {}};
      }

      b.maybeConnectSocket();
      return {_: 'auth.authorization', pFlags: {}, user: b.buildUser(userJson, true)};
    },

    'auth.signUp': async({first_name, last_name}) => {
      const name = joinName(first_name, last_name);
      if(!name) {
        throw tlError(400, 'FIRSTNAME_INVALID');
      }

      const userJson = await b.http.request('PUT', '/auth/profile', {name});
      b.maybeConnectSocket();
      return {_: 'auth.authorization', pFlags: {}, user: b.buildUser(userJson, true)};
    },

    'auth.logOut': async() => {
      await b.clearSession();
      return {_: 'auth.loggedOut', pFlags: {}};
    },

    'auth.resetAuthorizations': async() => {
      const response = await b.http.request('POST', '/auth/sessions/terminate-others', {});
      const token = jsonStr(response, 'token');
      if(token) {
        await b.setSession(token, b.selfMongoId);
      }

      return true;
    },

    // "Devices": GET /auth/sessions, DELETE /auth/sessions/:deviceId
    'account.getAuthorizations': async() => {
      const [devices, settings] = await Promise.all([
        b.http.requestArray('GET', '/auth/sessions'),
        b.http.request('GET', '/settings').catch((): Json => ({}))
      ]);

      const currentDeviceId = b.getDeviceId();
      const authorizations: Authorization.authorization[] = devices.map((d: Json) => {
        const deviceId = String(d.deviceId || '');
        const hash = idForUrl('session:' + deviceId);
        b.sessionHashToDeviceId.set(hash, deviceId);
        const date = parseIsoToEpochSeconds(d.lastActive);
        const current = deviceId === currentDeviceId;
        return {
          _: 'authorization',
          pFlags: current ? {current: true} : {},
          hash,
          device_model: String(d.deviceName || 'Unknown device'),
          platform: /web/i.test(deviceId) || /web/i.test(d.deviceName || '') ? 'Web' : 'Android',
          system_version: '',
          api_id: 0,
          app_name: SEVEN_NINE_APP_NAME,
          app_version: '',
          date_created: date,
          date_active: date,
          ip: String(d.ip || ''),
          country: '',
          region: ''
        };
      });

      const result: AccountAuthorizations.accountAuthorizations = {
        _: 'account.authorizations',
        authorization_ttl_days: +settings.authorizationTtlDays > 0 ? +settings.authorizationTtlDays : 180,
        authorizations
      };

      return result;
    },

    'account.resetAuthorization': async({hash}) => {
      const deviceId = b.sessionHashToDeviceId.get(String(hash));
      if(deviceId) {
        await b.http.request('DELETE', '/auth/sessions/' + encodeURIComponent(deviceId));
      }

      return true;
    },

    'account.setAuthorizationTTL': async({authorization_ttl_days}) => {
      await b.http.request('PUT', '/settings', {authorizationTtlDays: authorization_ttl_days});
      return true;
    },

    'account.changeAuthorizationSettings': () => true
  };
}
