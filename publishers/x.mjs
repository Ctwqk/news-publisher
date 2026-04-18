/**
 * X channel adapter.
 *
 * The public channel name remains "x", but delivery is delegated to the
 * standalone x-bot backend so the publisher no longer depends on a direct
 * Playwright path.
 */

export {
  formatItems,
  post,
  validateConfig,
} from './x-bot.mjs';
