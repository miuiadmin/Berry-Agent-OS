export interface PaginatedList<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PaginationParams {
  offset?: number;
  limit?: number;
}

export interface SortParams {
  field: string;
  direction: 'asc' | 'desc';
}

export type Timestamp = Date;
