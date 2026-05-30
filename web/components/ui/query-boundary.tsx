"use client";

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "./button";

interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
  errorTitle?: string;
}

export function QueryBoundary<T>({ query, skeleton, children, errorTitle }: QueryBoundaryProps<T>) {
  if (query.isLoading) {
    return <>{skeleton}</>;
  }

  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : "An error occurred";
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-5 text-destructive" />
        </div>
        <h3 className="mt-3 text-sm font-medium text-foreground">
          {errorTitle ?? "Failed to load"}
        </h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => query.refetch()}
        >
          <RefreshCw className="mr-1.5 size-3" />
          Retry
        </Button>
      </div>
    );
  }

  if (!query.data) {
    return <>{skeleton}</>;
  }

  return <>{children(query.data)}</>;
}
