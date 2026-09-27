"use client";

import { AreaError } from "@/components/layout/AreaError";

export default function Error({ retry }: { error: Error; retry: () => void }) {
  return <AreaError retry={retry} />;
}
