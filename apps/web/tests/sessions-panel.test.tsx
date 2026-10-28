import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationFeedPanel, SessionsPanel } from '@/features/settings/security/sessions-panel';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    ({
      'common.loading': 'Loading',
      'common.loadMore': 'Load more',
      'common.empty': 'Nothing here yet.',
      'errors.generic': 'Something went wrong. Try again.',
      'security.sessionsTitle': 'Sign-in sessions',
      'security.sessionsEmpty': 'Only this session is signed in.',
      'security.revokeOthers': 'Sign out elsewhere',
      'security.currentSession': 'this session',
      'security.revoke': 'Revoke',
      'security.unknownDevice': 'Unknown device',
      'security.notificationsTitle': 'In-app notices',
      'security.notificationsBody': 'Security alerts without secrets.',
      'notifications.empty': 'No security notices yet.',
      'notifications.markRead': 'Mark read',
      'notifications.kinds.security': 'Security notice',
    })[key] ?? key,
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    me: { settings: { locale: 'en' } },
    sessionEpoch: 1,
    signOut: mocks.signOut,
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  listSessions: mocks.listSessions,
  revokeSession: mocks.revokeSession,
  listNotifications: mocks.listNotifications,
  markNotificationRead: mocks.markNotificationRead,
}));

let sessionRevoked = false;
let notificationRead = false;

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionRevoked = false;
  notificationRead = false;
  mocks.signOut.mockResolvedValue(undefined);
  mocks.listSessions.mockImplementation(async () => ({
    items: sessionRevoked
      ? [
          {
            id: 'session-current',
            current: true,
            device_label: 'This device',
            user_agent: null,
            last_seen_at: '2026-09-16T00:00:00Z',
          },
        ]
      : [
          {
            id: 'session-current',
            current: true,
            device_label: 'This device',
            user_agent: null,
            last_seen_at: '2026-09-16T00:00:00Z',
          },
          {
            id: 'session-other',
            current: false,
            device_label: 'Other laptop',
            user_agent: null,
            last_seen_at: '2026-09-16T00:00:00Z',
          },
        ],
    next_cursor: null,
  }));
  mocks.listNotifications.mockImplementation(async () => ({
    items: [
      {
        id: 'notice-1',
        kind: 'security',
        read_at: notificationRead ? '2026-09-16T00:00:00Z' : null,
        created_at: '2026-09-16T00:00:00Z',
      },
    ],
    next_cursor: null,
  }));
  mocks.revokeSession.mockImplementation(async () => {
    sessionRevoked = true;
  });
  mocks.markNotificationRead.mockImplementation(async () => {
    notificationRead = true;
  });
});

afterEach(() => {
  cleanup();
});

describe('SessionsPanel mutations', () => {
  it('keeps a revoked row after failure and removes it after a successful retry', async () => {
    const user = userEvent.setup();
    mocks.revokeSession.mockRejectedValueOnce(new Error('offline'));
    renderWithQuery(<SessionsPanel onOpenRevokeDialog={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Try again.'));
    expect(screen.getByText('Other laptop')).toBeInTheDocument();
    expect(mocks.revokeSession).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('Other laptop')).not.toBeInTheDocument());
    expect(mocks.revokeSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('NotificationFeedPanel mutations', () => {
  it('keeps the unread marker after failure and clears it after a successful retry', async () => {
    const user = userEvent.setup();
    mocks.markNotificationRead.mockRejectedValueOnce(new Error('offline'));
    renderWithQuery(<NotificationFeedPanel />);

    await user.click(await screen.findByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Try again.'));
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(screen.getByText('Security notice')).toBeInTheDocument();
    expect(mocks.markNotificationRead).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument());
    expect(mocks.markNotificationRead).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
