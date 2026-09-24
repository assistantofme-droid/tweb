import {DcAuthKey, DcServerSalt, TrueDcId} from '@types';

export type ActiveAccountNumber = 1 | 2 | 3 | 4;

type A = Record<DcAuthKey, string> &
  Record<DcServerSalt, string> &
  {
    auth_key_fingerprint: string,
    push_key?: string,
    push_key_fingerprint?: string,
    userId: PeerId,
    dcId: TrueDcId,
    date: number,
    // 7eve9Chat backend session (see @lib/sevenNine/restBridge)
    seven_nine_token: string,
    seven_nine_self_id: string
  };

export type AccountSessionData = Partial<A>;
