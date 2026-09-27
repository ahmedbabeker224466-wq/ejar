export function AreaLoading() {
  return (
    <div role="status" className="flex flex-col items-center gap-4 pt-24">
      <div className="size-10 animate-spin rounded-full border-4 border-primary-soft border-t-primary" />
      <p className="text-lg text-foreground-muted">جارٍ التحميل…</p>
    </div>
  );
}
