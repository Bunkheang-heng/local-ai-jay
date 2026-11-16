import os from 'node:os';
import path from 'node:path';

export function homeDir(env = process.env) {
  if (env.LOCAL_AI_JAY_HOME) return path.resolve(env.LOCAL_AI_JAY_HOME);
  return path.join(os.homedir(), '.local-ai-jay');
}

export function getPaths(home = homeDir()) {
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state'),
    logs: path.join(home, 'logs'),
    workspace: path.join(home, 'workspace'),
    env: path.join(home, 'env'),
  };
}
