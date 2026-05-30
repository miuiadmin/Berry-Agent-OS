import Link from "next/link";
import { FileQuestion } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-muted">
          <FileQuestion className="size-8 text-muted-foreground" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90 transition-colors"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
