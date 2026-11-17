// sf serve's socket handler: each request is a command of the table in src/commands.ts,
// its arguments checked with the CLI's own checkArgs, refused while sf update drains or builds
// unless the command stays open, then run.
import { COMMANDS, checkArgs, type Serve, socketCommand } from './commands.js';
import { FactoryError } from './errors.js';
import type { IpcHandler } from './ipc.js';
import type { TestHooks } from './test-hooks.js';
import { refuseWhileUpdating } from './update.js';
import { ensureVisionRoot } from './vision.js';

export interface SocketHandlerOptions extends Serve {
  stateDir: string;
  // The test hooks (src/test-hooks.ts): with socketCommands, the tests' commands (check, fix,
  // clean) answer.
  testHooks: TestHooks;
  // After a queue command that changed the queue.
  onQueueChange(): void;
  // After an sf coordinator command that wrote the coordinator's state (all but the read and
  // wait-request, which write nothing).
  onCoordinatorChange(): void;
}

export function socketHandler(options: SocketHandlerOptions): IpcHandler {
  // <state>/vision before sf serve listens or resumes a job: each session started later denies it.
  ensureVisionRoot(options.stateDir);
  return async ({ command: name, args }) => {
    const command = socketCommand(name);
    // The updating marker's gate: every command that changes something is refused before
    // it does, an unknown one too.
    if (command?.openWhileUpdating !== true) {
      refuseWhileUpdating(options.stateDir);
    }
    if (command === undefined || (command.testOnly === true && !options.testHooks.socketCommands)) {
      throw new FactoryError('bad_request', `Unknown command "${name}".`);
    }
    const checked = checkArgs(command, args);
    const result = await command.run(options, checked.args, checked.flags);
    if (command.name.startsWith('queue ') && command !== COMMANDS.queueList) {
      options.onQueueChange();
    }
    if (command.name.startsWith('coordinator ') && command !== COMMANDS.coordinatorWaitRequest) {
      options.onCoordinatorChange();
    }
    return result;
  };
}
