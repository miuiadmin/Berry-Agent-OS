"use client";

import { useEffect, useCallback, useState } from "react";
import { X, ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
  const [error, setError] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, handleKeyDown]);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 flex size-9 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close"
      >
        <X className="size-5" />
      </button>
      {error ? (
        <div className="flex flex-col items-center gap-3 text-white/60">
          <ImageOff className="size-12" />
          <span className="text-sm">Failed to load image</span>
        </div>
      ) : (
        <img
          src={src}
          alt={alt || ""}
          className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
}

export function ClickableImage({
  src,
  alt,
  className,
}: {
  src?: string;
  alt?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);

  if (!src) return null;

  if (error) {
    return (
      <div className={cn("flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground", className)}>
        <ImageOff className="size-4" />
        <span>{alt || "Image failed to load"}</span>
      </div>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ""}
        className={cn("rounded-lg max-w-full max-h-80 cursor-pointer hover:opacity-90 transition-opacity my-2", className)}
        onClick={() => setOpen(true)}
        onError={() => setError(true)}
      />
      <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
