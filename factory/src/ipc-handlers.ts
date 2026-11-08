// sf serve's socket handler (SF-138): each request is a command of the table in src/commands.ts,
// its arguments checked with the CLI's own checkArgs, refused while sf update drains or builds
// unless the command stays open, then run.
import { COMMANDS, checkArgs, type Serve, socketCommand } from './commands.js';
import { FactoryError } from './errors.js';
import type { IpcHandler } from './ipc.js';
import { refuseWhileUpdating } from './update.js';

export interface SocketHandlerOptions extends Serve {
  stateDir: string;
  // SF_TEST_HOOKS=on: the tests' commands (check, fix, clean) answer.
  testHooks: boolean;
  // After a queue command that changed the queue.
  onQueueChange(): void;
}

export function socketHandler(options: SocketHandlerOptions): IpcHandler {
  return async ({ command: name, args }) => {
    const command = socketCommand(name);
    // The updating marker's gate (SF-101): every command that changes something is refused before
    // it does, an unknown one too.
    if (command?.openWhileUpdating !== true) {
      refuseWhileUpdating(options.stateDir);
    }
    if (command === undefined || (command.testOnly === true && !options.testHooks)) {
      throw new FactoryError('bad_request', `Unknown command "${name}".`);
    }
    const checked = checkArgs(command, args);
    const result = await command.run(options, checked.args, checked.flags);
    if (command.name.startsWith('queue ') && command !== COMMANDS.queueList) {
      options.onQueueChange();
    }
    return result;
  };
}
