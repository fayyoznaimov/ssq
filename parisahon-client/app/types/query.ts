// Basic primitive types allowed as query values
type Primitive = string | number | boolean | null;

// Common comparison operators for field-level filtering
interface ComparisonOperators {
  $in?: Primitive[];   // Value is in the array
  $nin?: Primitive[];  // Value is not in the array
  $lt?: Primitive;     // Less than
  $lte?: Primitive;    // Less than or equal to
  $gt?: Primitive;     // Greater than
  $gte?: Primitive;    // Greater than or equal to
  $ne?: Primitive;     // Not equal to
  // Add other operators supported by your backend if needed (e.g., $exists: boolean, $regex: string)
}

// Represents the possible value types when querying a specific field.
// It can be a direct primitive match, an object with comparison operators,
// or potentially a nested object for querying nested fields (using Record<string, any> for simplicity).
type FieldQueryValue = Primitive | ComparisonOperators | Record<string, any>;

// Type for the sort object: keys are field names, values are sort directions.
type SortQuery<T> = {
  // Allow sorting by known keys of the resource type T
  [P in keyof T]?: 1 | -1 | "asc" | "desc";
} & {
  // Also allow sorting by arbitrary string keys (e.g., nested fields like 'address.city')
  [key: string]: 1 | -1 | "asc" | "desc";
}

/**
 * Represents the query structure used for filtering, sorting, pagination,
 * and field selection in API requests, compatible with feathersjs/mongoose style queries.
 *
 * @template T The type of the resource being queried (optional, used for sort/select hints).
 */
export interface Query<T = any> {
  // --- Pagination ---
  /** Maximum number of results to return. */
  limit?: number;
  /** Number of results to skip (for pagination). */
  skip?: number;

  // --- Sorting ---
  /** Sort order for the results. */
  sort?: SortQuery<T>;

  // --- Field Selection ---
  /** Specify which fields to include in the results. */
  select?: (keyof T | string)[]; // Allow selecting by known keys of T or arbitrary strings

  // --- Logical Operators ---
  /**
   * Matches documents where *at least one* of the nested query objects is true.
   * Each object in the array is a query targeting fields of the resource.
   */
  or?: Record<string, FieldQueryValue>[];
  /**
   * Matches documents where *all* of the nested query objects are true.
   * (Note: 'and' is often implicit, but supported by some backends explicitly)
   */
  and?: Record<string, FieldQueryValue>[];

  // --- Field Filtering (using index signature) ---
  /**
   * Allows filtering directly by field names.
   * Example: { name: 'John Doe', age: { $gt: 30 }, 'address.city': 'New York' }
   * The key is the field name (can be nested using dot notation if backend supports it),
   * and the value is either a primitive for exact match, or an object containing
   * comparison operators (e.g., $in, $gt), or a nested object for deeper queries.
   */
  [key: string]:
    | FieldQueryValue
    | Primitive[] // Allow arrays for direct equality check if backend supports it
    | Query<T>["limit"] // Include types of known properties to satisfy index signature
    | Query<T>["skip"]
    | Query<T>["sort"]
    | Query<T>["select"]
    | Query<T>["or"]
    | Query<T>["and"]
    | undefined; // Allow undefined for optional properties

  // --- Optional: Stricter field typing (Uncomment/Adapt if needed) ---
  /**
   * Provides stricter type checking and intellisense for known fields of T.
   * This overlaps with the index signature above.
   */
  // [P in keyof T]?: FieldQueryValue | Primitive[];
}
