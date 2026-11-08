import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from '@/components/ui/dialog';

afterEach(() => {
  cleanup();
});

describe('Dialog focus & dismissible contract (P06 Task 6)', () => {
  it('restores focus to returnFocusRef on close even when opened without DialogTrigger', async () => {
    function ControlledHost() {
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div>
          <button
            ref={openerRef}
            type="button"
            onClick={() => setOpen(true)}
          >
            Open programmatically
          </button>
          <Dialog open={open} onOpenChange={setOpen} returnFocusRef={openerRef}>
            <DialogContent aria-describedby={undefined}>
              <div className="panel p-7">
                <DialogHeader title="Programmatic dialog" />
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="tertiary">Cancel</Button>
                  </DialogClose>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      );
    }

    render(<ControlledHost />);
    const opener = screen.getByRole('button', { name: 'Open programmatically' });
    opener.focus();
    await userEvent.click(opener);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Programmatic dialog')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('focuses initialFocusRef when opened and returns focus to returnFocusRef on Escape', async () => {
    function InitialFocusHost() {
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLButtonElement | null>(null);
      const secondaryInputRef = useRef<HTMLInputElement | null>(null);
      return (
        <div>
          <button
            ref={openerRef}
            type="button"
            onClick={() => setOpen(true)}
          >
            Launch
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              aria-describedby={undefined}
              initialFocusRef={secondaryInputRef}
              returnFocusRef={openerRef}
            >
              <div className="panel p-7">
                <DialogHeader title="Step 2 confirmation" />
                <input aria-label="First field" />
                <input ref={secondaryInputRef} aria-label="Confirm email" />
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="tertiary">Close</Button>
                  </DialogClose>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      );
    }

    render(<InitialFocusHost />);
    const opener = screen.getByRole('button', { name: 'Launch' });
    await userEvent.click(opener);

    await screen.findByRole('dialog');
    await waitFor(() => {
      expect(screen.getByLabelText('Confirm email')).toHaveFocus();
    });

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('blocks Escape and backdrop pointer-down when dismissible={false}, then allows Escape once re-enabled', async () => {
    function BusyDialogHost() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(true);
      return (
        <div>
          <Dialog open={open} onOpenChange={setOpen} dismissible={!busy}>
            <DialogContent aria-describedby={undefined}>
              <div className="panel p-7">
                <DialogHeader title="Exporting readable JSON" />
                <DialogFooter>
                  <button type="button" onClick={() => setBusy(false)}>
                    Finish step
                  </button>
                  <Button disabled={busy}>Done</Button>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      );
    }

    render(<BusyDialogHost />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Escape is blocked while dismissible={false}
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Pointer down outside is blocked while dismissible={false}
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Re-enable dismissal and press Escape
    fireEvent.click(screen.getByRole('button', { name: 'Finish step' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('L-4: with no returnFocusRef and no DialogTrigger, focus returns to the element that was focused when the dialog opened', async () => {
    function AutoHost() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open without ref
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <div className="panel p-7">
                <DialogHeader title="Auto-captured opener" />
                <DialogClose asChild>
                  <Button variant="tertiary">Cancel</Button>
                </DialogClose>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      );
    }
    render(<AutoHost />);
    const opener = screen.getByRole('button', { name: 'Open without ref' });
    opener.focus();
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('L-3: dismissible={false} blocks Escape/outside only; an explicit DialogClose press still closes', async () => {
    function HostedBusy() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen} dismissible={false}>
          <DialogContent aria-describedby={undefined}>
            <div className="panel p-7">
              <DialogHeader title="Busy but cancellable" />
              <DialogClose asChild>
                <Button variant="tertiary">Cancel</Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      );
    }
    render(<HostedBusy />);
    const dialog = await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('preserves standard DialogTrigger focus cycle when no custom refs are supplied', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="tertiary">Trigger</Button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <div className="panel p-7">
            <DialogHeader title="Default dialog" />
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="tertiary">Close</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole('button', { name: 'Trigger' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });
});
