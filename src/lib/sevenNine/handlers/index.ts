import type {BridgeHandlers, RestBridge} from '@lib/sevenNine/restBridge';
import systemHandlers from '@lib/sevenNine/handlers/system';
import authHandlers from '@lib/sevenNine/handlers/auth';
import businessHandlers from '@lib/sevenNine/handlers/business';
import messagesHandlers from '@lib/sevenNine/handlers/messages';
import usersHandlers from '@lib/sevenNine/handlers/users';
import filesHandlers from '@lib/sevenNine/handlers/files';

export default function registerAllHandlers(b: RestBridge): BridgeHandlers {
  return Object.assign(
    {},
    systemHandlers(b),
    authHandlers(b),
    businessHandlers(b),
    messagesHandlers(b),
    usersHandlers(b),
    filesHandlers(b)
  );
}
