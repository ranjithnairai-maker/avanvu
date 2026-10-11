import { site } from '@/lib/site';

/** Legal text must be reviewed by counsel before launch (SPEC §12.8, D-25). The notice disappears once that is confirmed. */
export function DraftNotice() {
  if (site.legalReviewed) return null;
  return (
    <p className="notice" role="note">
      Draft for review. This document has not yet been reviewed by legal counsel and may change before{' '}
      {`Avanvu's`} public launch.
    </p>
  );
}

export function SupportContact() {
  return site.supportEmail ? (
    <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
  ) : (
    <span>the support address, which will be published at launch</span>
  );
}
