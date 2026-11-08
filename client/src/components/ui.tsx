/** Small shared UI building blocks. */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/** Tab strip of a dialog; the caller shows the selected tab's content. */
export function DialogTabs<T extends string>({
  tabs,
  selected,
  onSelect,
}: {
  tabs: { id: T; label: string }[];
  selected: T;
  onSelect(tab: T): void;
}) {
  return (
    <div className="pp-dialog-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === selected}
          className={t.id === selected ? "pp-tab-selected" : undefined}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog ref={ref} className="pp-dialog" onClose={onClose} onCancel={onClose}>
      <header>
        <h2>{title}</h2>
        <button type="button" className="pp-icon-button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="pp-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

/**
 * A labelled form control. The control is named by the label text only
 * (aria-labelledby): a select inside a <label> would otherwise be named by all
 * of its options too.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-labelledby"?: string }>, {
        "aria-labelledby": id,
      })
    : children;
  return (
    <label className="pp-field">
      <span id={id}>{label}</span>
      {control}
    </label>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? (
    <p className="pp-error" role="alert">
      {error}
    </p>
  ) : null;
}

/** Run an async action, tracking busy state and error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function Badge({
  className,
  title,
  children,
}: {
  className: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <span className={`pp-badge ${className}`} title={title}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="pp-empty">{children}</p>;
}
