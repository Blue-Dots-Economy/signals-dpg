type JsonRecord = Record<string, unknown>;

export type SplitItemState = {
  publicState: JsonRecord;
  privateState: JsonRecord;
};

export function splitItemStateByPrivacy(
  itemSchema: JsonRecord,
  itemState: JsonRecord
): SplitItemState {
  return splitObjectState(itemSchema, itemState);
}

export function mergeItemStateWithPrivate(
  publicState: JsonRecord,
  privateState: JsonRecord
): JsonRecord {
  return mergeObjects(publicState, privateState);
}

/**
 * Same merge semantics as mergeItemStateWithPrivate. Named alias for the
 * "merge mask values into the public mirror at create/update time" call site,
 * so reader intent is clear.
 */
export function mergeMasksIntoPublic(
  publicState: JsonRecord,
  maskedPrivate: JsonRecord
): JsonRecord {
  return mergeItemStateWithPrivate(publicState, maskedPrivate);
}

export function projectPrivateStateForSchema(
  schema: JsonRecord,
  privateState: JsonRecord
): JsonRecord {
  return projectObjectForSchema(schema, privateState);
}

function splitObjectState(schema: JsonRecord, state: JsonRecord): SplitItemState {
  const properties = getSchemaProperties(schema);
  const publicState: JsonRecord = {};
  const privateState: JsonRecord = {};

  for (const [key, value] of Object.entries(state)) {
    const propertySchema = properties[key];

    if (isPrivateSchema(propertySchema)) {
      privateState[key] = value;
      continue;
    }

    if (isPlainObject(propertySchema) && isPlainObject(value)) {
      const nested = splitObjectState(propertySchema, value);

      if (Object.keys(nested.publicState).length > 0) {
        publicState[key] = nested.publicState;
      }

      if (Object.keys(nested.privateState).length > 0) {
        privateState[key] = nested.privateState;
      }

      continue;
    }

    if (isPlainObject(propertySchema) && Array.isArray(value)) {
      const itemSchema = isPlainObject(propertySchema.items)
        ? propertySchema.items
        : null;

      if (itemSchema) {
        const splitArray = splitArrayState(itemSchema, value);

        if (splitArray.publicValues.length > 0) {
          publicState[key] = splitArray.publicValues;
        }

        if (splitArray.privateValues.length > 0) {
          privateState[key] = splitArray.privateValues;
        }

        continue;
      }
    }

    publicState[key] = value;
  }

  return { publicState, privateState };
}

function splitArrayState(schema: JsonRecord, values: unknown[]) {
  const publicValues: unknown[] = [];
  const privateValues: unknown[] = [];
  let hasPrivateValues = false;

  for (const value of values) {
    if (!isPlainObject(value)) {
      publicValues.push(value);
      privateValues.push(null);
      continue;
    }

    const nested = splitObjectState(schema, value);
    publicValues.push(nested.publicState);
    privateValues.push(nested.privateState);

    if (Object.keys(nested.privateState).length > 0) {
      hasPrivateValues = true;
    }
  }

  return {
    publicValues,
    privateValues: hasPrivateValues ? privateValues : [],
  };
}

function projectObjectForSchema(schema: JsonRecord, state: JsonRecord): JsonRecord {
  const properties = getSchemaProperties(schema);
  const projection: JsonRecord = {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(state, key)) {
      continue;
    }

    const value = state[key];

    if (isPlainObject(propertySchema) && isPlainObject(value)) {
      const nested = projectObjectForSchema(propertySchema, value);

      if (Object.keys(nested).length > 0) {
        projection[key] = nested;
      }

      continue;
    }

    if (isPlainObject(propertySchema) && Array.isArray(value)) {
      const itemSchema = isPlainObject(propertySchema.items)
        ? propertySchema.items
        : null;

      if (itemSchema) {
        projection[key] = value.map((entry) =>
          isPlainObject(entry) ? projectObjectForSchema(itemSchema, entry) : entry
        );
        continue;
      }
    }

    projection[key] = value;
  }

  return projection;
}

function mergeObjects(publicState: JsonRecord, privateState: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...publicState };

  for (const [key, value] of Object.entries(privateState)) {
    const publicValue = merged[key];

    if (isPlainObject(publicValue) && isPlainObject(value)) {
      merged[key] = mergeObjects(publicValue, value);
      continue;
    }

    if (Array.isArray(publicValue) && Array.isArray(value)) {
      merged[key] = publicValue.map((entry, index) => {
        const privateEntry = value[index];
        return isPlainObject(entry) && isPlainObject(privateEntry)
          ? mergeObjects(entry, privateEntry)
          : privateEntry ?? entry;
      });
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function getSchemaProperties(schema: JsonRecord): Record<string, unknown> {
  return isPlainObject(schema.properties) ? schema.properties : {};
}

function isPrivateSchema(schema: unknown) {
  return isPlainObject(schema) && schema.private === true;
}

function isPlainObject(input: unknown): input is JsonRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
