type PageHeaderProps = {
  title: string;
  subtitle?: string;
};

export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-2 pt-8 pb-6">
      <h1 className="text-3xl font-bold leading-tight">{title}</h1>
      {subtitle && (
        <p className="text-lg text-foreground-muted">{subtitle}</p>
      )}
    </header>
  );
}
