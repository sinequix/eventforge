import type { ReactNode } from "react";

const SINEQUIX_URL = "https://sinequix.com";

export function CopyrightNotice() {
  const year = new Date().getFullYear();
  return (
    <div className="ef-footer-legal">
      <p>© {year} Sinequix. All rights reserved.</p>
      <p>
        A{" "}
        <a href={SINEQUIX_URL} rel="noopener noreferrer" target="_blank">
          Sinequix
        </a>{" "}
        venture
      </p>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="ef-footer ef-site-footer">
      <CopyrightNotice />
    </footer>
  );
}

// Marketing pages embed CopyrightNotice in the footer they already have.
// Every other route gets the same notice from this shell.
export function SiteLayout({
  children,
  includeFooter,
}: {
  children: ReactNode;
  includeFooter: boolean;
}) {
  if (!includeFooter) return children;
  return (
    <div className="ef-site-shell">
      {children}
      <SiteFooter />
    </div>
  );
}
