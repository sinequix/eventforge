import type { ReactNode } from "react";

export function ViewChrome({
  eyebrow,
  title,
  description,
  error,
  notice,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  error?: string;
  notice?: string;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8">
      <p className="eyebrow mb-1 text-xs font-medium uppercase tracking-[.18em]">{eyebrow}</p>
      <h2 className="mb-2 text-2xl font-semibold tracking-tight">{title}</h2>
      {description && <p className="muted-text mb-6 max-w-3xl text-sm">{description}</p>}
      {error && (
        <p className="error-notice mb-4 rounded-lg px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice mb-4 rounded-lg px-4 py-3 text-sm" role="status">
          {notice}
        </p>
      )}
      {children}
    </section>
  );
}
