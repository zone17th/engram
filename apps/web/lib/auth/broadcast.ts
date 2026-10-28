export type SessionBroadcast =
  | { type: 'session_changed' }
  | { type: 'signed_out'; reason?: 'revoked' | 'expired' | 'invalid' | 'logout' };

export type SessionBroadcastOrigin = 'local' | 'remote';

const CHANNEL = 'sabk.auth.session';

let channel: BroadcastChannel | null = null;
const subscribers = new Set<(message: SessionBroadcast, origin: SessionBroadcastOrigin) => void>();

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

export function postSessionBroadcast(message: SessionBroadcast): void {
  for (const subscriber of [...subscribers]) subscriber(message, 'local');
  getChannel()?.postMessage(message);
}

export function subscribeSessionBroadcast(
  handler: (message: SessionBroadcast, origin: SessionBroadcastOrigin) => void,
): () => void {
  subscribers.add(handler);
  const ch = getChannel();
  if (!ch) return () => subscribers.delete(handler);
  const listener = (event: MessageEvent<SessionBroadcast>) => {
    if (event.data?.type === 'session_changed' || event.data?.type === 'signed_out') {
      handler(event.data, 'remote');
    }
  };
  ch.addEventListener('message', listener);
  return () => {
    subscribers.delete(handler);
    ch.removeEventListener('message', listener);
  };
}
