import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountDialogs,
  useAccountDialogs,
} from '@/features/settings/account/account-dialogs';

const mocks = vi.hoisted(() => ({
  changeEmail: vi.fn(),
  changePassword: vi.fn(),
  oauthLinkStart: vi.fn(),
  revokeOtherSessions: vi.fn(),
  unlinkIdentity: vi.fn(),
  begin: vi.fn(),
  cancel: vi.fn(),
  clearGrant: vi.fn(),
  submitPassword: vi.fn(),
  refetchMe: vi.fn(),
  invalidateQueries: vi.fn(),
  assign: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === 'common.cancel') return 'Cancel';
    if (key === 'common.continue') return 'Continue';
    if (key === 'dialogs.reauth.submit') return 'Confirm';
    if (key === 'dialogs.reauth.submitting') return 'Confirming';
    if (key === 'dialogs.password.new') return 'New password';
    if (key === 'dialogs.password.confirm') return 'Confirm password';
    if (key === 'dialogs.password.submit') return 'Save password';
    if (key === 'dialogs.unlink.submit') return 'Unlink';
    if (key === 'dialogs.reauth.password') return 'Password';
    if (key === 'dialogs.link.title') return `Link ${values?.provider ?? 'provider'}`;
    if (key === 'dialogs.unlink.title') return `Unlink ${values?.provider ?? 'provider'}`;
    return key;
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    me: {
      identities: [{ provider: 'password' }],
    },
    reauth: {
      capabilities: {
        hasPassword: true,
        oauthReauthProviders: [],
      },
      begin: mocks.begin,
      cancel: mocks.cancel,
      clearGrant: mocks.clearGrant,
      grant: null,
      hasUsableGrant: () => false,
      submitPassword: mocks.submitPassword,
      error: null,
    },
    refetchMe: mocks.refetchMe,
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  changeEmail: mocks.changeEmail,
  changePassword: mocks.changePassword,
  oauthLinkStart: mocks.oauthLinkStart,
  revokeOtherSessions: mocks.revokeOtherSessions,
  unlinkIdentity: mocks.unlinkIdentity,
}));

function Harness() {
  const dialogs = useAccountDialogs();
  return (
    <>
      <button type="button" onClick={() => dialogs.open('linkProviderDlg', { provider: 'google' })}>
        Open link
      </button>
      <button type="button" onClick={() => dialogs.open('unlinkProviderDlg', { provider: 'google' })}>
        Open unlink
      </button>
      <button type="button" onClick={() => dialogs.open('passwordChangeDlg')}>
        Open password
      </button>
      <AccountDialogs
        active={dialogs.active}
        context={dialogs.context}
        close={dialogs.close}
        open={dialogs.open}
      />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue(undefined);
  mocks.submitPassword.mockResolvedValue({
    action: 'account.identity_link',
    grant: 'grant-token',
    expires_at: '2099-01-01T00:00:00Z',
  });
  mocks.oauthLinkStart.mockResolvedValue({ authorization_url: 'https://accounts.example.test/link' });
  mocks.changePassword.mockResolvedValue(undefined);
  mocks.unlinkIdentity.mockResolvedValue(undefined);
  mocks.refetchMe.mockResolvedValue(undefined);
  mocks.invalidateQueries.mockResolvedValue(undefined);
  const testWindow = Object.create(window) as Window;
  Object.defineProperty(testWindow, 'location', {
    configurable: true,
    value: { assign: mocks.assign },
  });
  vi.stubGlobal('window', testWindow);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AccountDialogs reauthentication', () => {
  it('clears password fields after a successful password replacement', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open password' }));
    await user.type(screen.getByLabelText('New password'), 'new-password-12');
    await user.type(screen.getByLabelText('Confirm password'), 'new-password-12');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    await user.type(screen.getByLabelText('Password'), 'current-password');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(mocks.changePassword).toHaveBeenCalledWith(
        { new_password: 'new-password-12' },
        'grant-token',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open password' }));
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
  });

  it('clears password fields when the password dialog is cancelled and reopened', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open password' }));
    await user.type(screen.getByLabelText('New password'), 'new-password-12');
    await user.type(screen.getByLabelText('Confirm password'), 'new-password-12');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Open password' }));
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
  });

  it('keeps the provider while linking through password reauth', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Password'), 'current-password');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mocks.oauthLinkStart).toHaveBeenCalledWith('google', 'grant-token'));
    expect(mocks.assign).toHaveBeenCalledWith('https://accounts.example.test/link');
  });

  it('keeps the provider while unlinking through password reauth', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open unlink' }));
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await user.type(screen.getByLabelText('Password'), 'current-password');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mocks.unlinkIdentity).toHaveBeenCalledWith('google', 'grant-token'));
    expect(mocks.refetchMe).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['auth', 'sessions'] });
  });

  it('cancelling reauth does not mutate the account', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.oauthLinkStart).not.toHaveBeenCalled();
    expect(mocks.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('clears a typed reauth password when the dialog is cancelled and reopened', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Password'), 'stale-password');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('clears the pending password form when reauth is cancelled', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open password' }));
    await user.type(screen.getByLabelText('New password'), 'new-password-12');
    await user.type(screen.getByLabelText('Confirm password'), 'new-password-12');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    await user.type(screen.getByLabelText('Password'), 'stale-password');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Open password' }));
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
  });

  it('clears a typed reauth password when the dialog is closed and reopened', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Password'), 'stale-password');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});
