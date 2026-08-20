import "./data-table.css";
import "../ResizableTable/resizable-columns.css";

import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { useResizableColumns } from "../ResizableTable/useResizableColumns.ts";

export type ColumnAlign = "left" | "right";
export type ColumnKind = "text" | "number" | "time" | "custom";

export type DataTableColumn<Row, K extends string = string> = {
  key: K;
  label: string;
  tip?: string;
  align?: ColumnAlign;
  kind?: ColumnKind;
  sortable?: boolean;
  resizable?: boolean;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  cls?: string;
  render: (row: Row) => ReactNode;
  sortValue?: (row: Row) => string | number | null;
};

export type DataTableProps<Row, K extends string = string> = {
  rows: Row[];
  columns: DataTableColumn<Row, K>[];
  rowId: (row: Row) => string;
  storageKey?: string;
  initialSort?: { key: K; dir?: 1 | -1 };
  sort?: { key: K; dir: 1 | -1 } | null;
  onSortChange?: (sort: { key: K; dir: 1 | -1 }) => void;
  secondarySort?: (a: Row, b: Row) => number;
  onRowClick?: (row: Row) => void;
  rowBindings?: (id: string) => Record<string, unknown>;
  rowState?: (id: string) => { isActive: boolean; isPinned: boolean };
  empty?: { title: string; body?: string };
  loading?: boolean;
  rowClassName?: (row: Row) => string | undefined;
  density?: "compact" | "comfortable";
  className?: string;
  ariaLabel?: string;
};

type SortState<K extends string> = { key: K; dir: 1 | -1 } | null;

type NormalizedColumn<Row, K extends string> = DataTableColumn<Row, K> & {
  kind: ColumnKind;
  align: ColumnAlign;
  sortable: boolean;
  resizable: boolean;
};

function inferAlign(kind: ColumnKind): ColumnAlign {
  return kind === "number" || kind === "time" ? "right" : "left";
}

function defaultSortDir(kind: ColumnKind): 1 | -1 {
  return kind === "number" || kind === "time" ? -1 : 1;
}

function toText(value: ReactNode): string {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => toText(item)).join("");
  return "";
}

function valueForSort<Row, K extends string>(column: NormalizedColumn<Row, K>, row: Row): string | number | null {
  if (column.sortValue) return column.sortValue(row);
  const rendered = column.render(row);
  const text = toText(rendered).trim();
  return text ? text : null;
}

function asTimeNumber(value: string | number): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function compareValues<Row, K extends string>(
  a: Row,
  b: Row,
  column: NormalizedColumn<Row, K>,
  dir: 1 | -1,
): number {
  const left = valueForSort(column, a);
  const right = valueForSort(column, b);

  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;

  if (column.kind === "number") {
    return ((Number(left) || 0) - (Number(right) || 0)) * dir;
  }

  if (column.kind === "time") {
    return (asTimeNumber(left) - asTimeNumber(right)) * dir;
  }

  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }) * dir;
}

function composeMouseClick(
  upstream: unknown,
  downstream?: (event: ReactMouseEvent<HTMLTableRowElement>) => void,
) {
  return (event: ReactMouseEvent<HTMLTableRowElement>) => {
    if (typeof upstream === "function") {
      (upstream as (event: ReactMouseEvent<HTMLTableRowElement>) => void)(event);
    }
    if (!event.defaultPrevented) downstream?.(event);
  };
}

function composeKeyDown(
  upstream: unknown,
  downstream?: (event: ReactKeyboardEvent<HTMLTableRowElement>) => void,
) {
  return (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (typeof upstream === "function") {
      (upstream as (event: ReactKeyboardEvent<HTMLTableRowElement>) => void)(event);
    }
    if (!event.defaultPrevented) downstream?.(event);
  };
}

export function DataTable<Row, K extends string = string>({
  rows,
  columns,
  rowId,
  storageKey,
  initialSort,
  sort: controlledSort,
  onSortChange,
  secondarySort,
  onRowClick,
  rowBindings,
  rowState,
  empty = { title: "No rows" },
  loading = false,
  rowClassName,
  density = "comfortable",
  className,
  ariaLabel = "Data table",
}: DataTableProps<Row, K>) {
  const normalizedColumns = useMemo<NormalizedColumn<Row, K>[]>(() => (
    columns.map((column) => {
      const kind = column.kind ?? "text";
      return {
        ...column,
        kind,
        align: column.align ?? inferAlign(kind),
        sortable: column.sortable ?? kind !== "custom",
        resizable: column.resizable ?? true,
      };
    })
  ), [columns]);

  const columnsByKey = useMemo(
    () => new Map(normalizedColumns.map((column) => [column.key, column])),
    [normalizedColumns],
  );

  const [internalSort, setInternalSort] = useState<SortState<K>>(() => {
    if (!initialSort) return null;
    const column = columns.find((entry) => entry.key === initialSort.key);
    const kind = column?.kind ?? "text";
    return { key: initialSort.key, dir: initialSort.dir ?? defaultSortDir(kind) };
  });
  const sort = controlledSort ?? internalSort;

  const { getColumnProps, getResizeHandleProps } = useResizableColumns<K>({
    storageKey,
    columns: normalizedColumns.map((column) => ({
      key: column.key,
      defaultWidth: column.defaultWidth,
      minWidth: column.minWidth,
      maxWidth: column.maxWidth,
    })),
  });

  const sortedRows = useMemo(() => {
    const withIndex = rows.map((row, index) => ({ row, index }));
    if (!sort) return withIndex.map((entry) => entry.row);
    const column = columnsByKey.get(sort.key);
    if (!column?.sortable) return withIndex.map((entry) => entry.row);

    return withIndex
      .slice()
      .sort((left, right) => {
        const primary = compareValues(left.row, right.row, column, sort.dir);
        if (primary !== 0) return primary;
        const secondary = secondarySort?.(left.row, right.row) ?? 0;
        if (secondary !== 0) return secondary;
        return left.index - right.index;
      })
      .map((entry) => entry.row);
  }, [rows, sort, columnsByKey, secondarySort]);

  const applySortChange = (next: { key: K; dir: 1 | -1 }) => {
    if (controlledSort == null) {
      setInternalSort(next);
    }
    onSortChange?.(next);
  };

  return (
    <div className={`dt-wrap dt-wrap--${density}${className ? ` ${className}` : ""}`}>
      <table className="dt-table" aria-label={ariaLabel} aria-busy={loading || undefined}>
        <thead>
          <tr>
            {normalizedColumns.map((column) => {
              const isSorted = sort?.key === column.key;
              const ariaSort = isSorted ? (sort.dir === 1 ? "ascending" : "descending") : "none";
              const headerClass = [
                "dt-th",
                `dt-align-${column.align}`,
                column.cls,
                isSorted ? "dt-th--sorted" : "",
              ].filter(Boolean).join(" ");

              return (
                <th
                  key={column.key}
                  className={headerClass}
                  title={column.tip}
                  aria-sort={ariaSort}
                  {...getColumnProps(column.key)}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className="dt-th-sort"
                      onClick={() => {
                        if (sort?.key === column.key) {
                          applySortChange({ key: column.key, dir: sort.dir === 1 ? -1 : 1 });
                          return;
                        }
                        applySortChange({ key: column.key, dir: defaultSortDir(column.kind) });
                      }}
                    >
                      <span className="dt-th-label">{column.label}</span>
                      <span className={`dt-th-arrow${isSorted ? " dt-th-arrow--active" : ""}`} aria-hidden="true">
                        {isSorted ? (sort?.dir === 1 ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    <div className="dt-th-static">
                      <span className="dt-th-label">{column.label}</span>
                    </div>
                  )}
                  {column.resizable ? <span {...getResizeHandleProps(column.key)} /> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && sortedRows.length === 0 ? (
            <tr className="dt-loading-row">
              <td colSpan={normalizedColumns.length}>
                <div className="dt-loading" role="status" aria-label={`Loading ${ariaLabel.toLowerCase()}`}>
                  {Array.from({ length: 7 }, (_, index) => (
                    <div className="dt-loading-line" key={index} aria-hidden="true">
                      {normalizedColumns.map((column) => (
                        <span key={column.key} style={{ width: `${Math.min(column.defaultWidth, 220)}px` }} />
                      ))}
                    </div>
                  ))}
                </div>
              </td>
            </tr>
          ) : sortedRows.length === 0 ? (
            <tr className="dt-empty-row">
              <td colSpan={normalizedColumns.length}>
                <div className="dt-empty">
                  <div className="dt-empty-title">{empty.title}</div>
                  {empty.body ? <div>{empty.body}</div> : null}
                </div>
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => {
              const id = rowId(row);
              const bindings = rowBindings?.(id) ?? {};
              const state = rowState?.(id) ?? { isActive: false, isPinned: false };
              const interactive = Boolean(onRowClick || rowBindings);
              const rowClasses = [
                "dt-row",
                interactive ? "dt-row--interactive" : "",
                state.isActive ? "dt-row--active" : "",
                state.isPinned ? "dt-row--pinned" : "",
                rowClassName?.(row),
                typeof bindings.className === "string" ? bindings.className : "",
              ].filter(Boolean).join(" ");

              const handleRowClick = onRowClick
                ? () => onRowClick(row)
                : undefined;

              const onKeyDown = interactive
                ? composeKeyDown(bindings.onKeyDown, (event) => {
                    if (!onRowClick) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowClick(row);
                    }
                  })
                : (typeof bindings.onKeyDown === "function"
                    ? bindings.onKeyDown as (event: ReactKeyboardEvent<HTMLTableRowElement>) => void
                    : undefined);

              const rowProps: Record<string, unknown> = {
                ...bindings,
                className: rowClasses,
                onClick: composeMouseClick(bindings.onClick, handleRowClick),
                onKeyDown,
              };

              if (interactive && rowProps.tabIndex == null) {
                rowProps.tabIndex = 0;
              }

              return (
                <tr key={id} {...rowProps}>
                  {normalizedColumns.map((column) => (
                    <td
                      key={column.key}
                      className={[
                        "dt-td",
                        `dt-align-${column.align}`,
                        column.cls,
                      ].filter(Boolean).join(" ")}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
