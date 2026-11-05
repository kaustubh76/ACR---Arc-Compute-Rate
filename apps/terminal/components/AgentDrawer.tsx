"use client";

import dynamic from "next/dynamic";
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

const AgentChat = dynamic(() => import("./AgentChat"), {
  ssr: false,
  loading: () => (
    <p className="agent-notice" role="status">
      Opening ACR Agent…
    </p>
  ),
});
const DrawerContext = createContext({ open: false, toggle: () => {}, available: false });

export function AskAgentButton() {
  const { open, toggle, available } = useContext(DrawerContext);
  // No launcher outside a drawer: the ops host renders none (lib/opsOrigin.ts).
  if (!available) return null;
  return (
    <button
      className="agent-launch"
      onClick={toggle}
      aria-expanded={open}
      aria-controls="acr-agent-drawer"
      aria-label="Ask ACR Agent"
    >
      {/* On a phone only the mark shows: the full label pushed the two
          toggles onto a third header row, past the masthead's two-row budget. */}
      <span className="agent-launch-text">Ask ACR Agent</span>
      <span className="agent-launch-arrow" aria-hidden="true">↗</span>
      <span className="agent-launch-mark" aria-hidden="true">✦</span>
    </button>
  );
}

class ChatBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="agent-notice" role="alert">
        <h3>Chat couldn’t load</h3>
        <p>You can keep using ACR. Reload the page to try the agent again.</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function AgentDrawer({
  children,
  applicationId,
}: {
  children: ReactNode;
  applicationId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [width, setWidth] = useState(440);
  const [mobile, setMobile] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drawer = useRef<HTMLElement>(null);
  const path = usePathname();
  const suggestion = path.startsWith("/check")
      ? "Help me review a compute bill"
      : path.startsWith("/attack")
        ? "Explain ACR’s manipulation resistance"
        : "Explain today’s compute rates";

  useEffect(() => {
    if (open) closeButton.current?.focus({ preventScroll: true });
    else opener.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setMobile(query.matches);
      setWidth((w) => Math.min(w, Math.max(360, window.innerWidth - 480)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!open || !mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, mobile]);

  function close() {
    setOpen(false);
  }
  function toggle() {
    if (open) {
      close();
      return;
    }
    opener.current = document.activeElement as HTMLElement;
    setMounted(true);
    setOpen(true);
  }

  return (
    <DrawerContext.Provider value={{ open, toggle, available: true }}>
      <div
        className="agent-layout"
        data-agent-open={open}
        style={{ "--agent-width": `${width}px` } as CSSProperties}
      >
        <div className="agent-page" inert={open && mobile}>
          {children}
        </div>
        <aside
          id="acr-agent-drawer"
          ref={drawer}
          className="agent-drawer"
          role={mobile ? "dialog" : "complementary"}
          aria-modal={mobile && open ? true : undefined}
          aria-labelledby="acr-agent-title"
          aria-hidden={!open}
          inert={!open}
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              open &&
              (document.activeElement === opener.current ||
                document.activeElement === document.body)
            ) {
              closeButton.current?.focus({ preventScroll: true });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.stopPropagation();
              close();
            }
            if (event.key !== "Tab" || !mobile) return;
            const targets = Array.from(
              drawer.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]',
              ) ?? [],
            ).filter(
              (el) => el.getClientRects().length && !el.closest("[inert]"),
            );
            const first = targets[0],
              last = targets[targets.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <div
            className="agent-resize"
            role="separator"
            aria-label="Resize agent panel"
            aria-orientation="vertical"
            aria-valuemin={360}
            aria-valuemax={680}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                setWidth(
                  Math.max(
                    360,
                    Math.min(
                      680,
                      window.innerWidth - 480,
                      window.innerWidth - event.clientX,
                    ),
                  ),
                );
            }}
            onPointerUp={(event) =>
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setWidth((w) =>
                  Math.max(
                    360,
                    Math.min(
                      680,
                      window.innerWidth - 480,
                      w + (event.key === "ArrowLeft" ? 24 : -24),
                    ),
                  ),
                );
              }
            }}
          />
          <header className="agent-heading">
            <div>
              <span className="agent-eyebrow">YOUR COMPUTE DESK</span>
              <h2 id="acr-agent-title">
                ACR Agent <span>✦</span>
              </h2>
              <p>Powered by Aomi</p>
            </div>
            <button
              ref={closeButton}
              className="agent-close"
              onClick={close}
              aria-label="Close ACR Agent"
            >
              ×
            </button>
          </header>
          <div className="agent-context">
            <span>TRY ASKING</span>
            <p>“{suggestion}”</p>
          </div>
          <div className="agent-chat">
            {mounted &&
              (applicationId ? (
                <ChatBoundary>
                  <AgentChat applicationId={applicationId} />
                </ChatBoundary>
              ) : (
                <div className="agent-notice" role="status">
                  <h3>The agent is not connected yet</h3>
                  <p>
                    Compute rates and bill checks are still available on the
                    site. Chat will be available once this deployment connects
                    its ACR app.
                  </p>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </DrawerContext.Provider>
  );
}
