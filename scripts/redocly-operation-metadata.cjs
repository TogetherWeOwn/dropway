function hasExample(value) {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "example") || (value.examples && Object.keys(value.examples).length)) return true;
  return Object.values(value).some(hasExample);
}

module.exports = {
  id: "dropway",
  rules: {
    oas3: {
      "operation-metadata": () => ({
        Operation(operation, { report, location }) {
          // Browser pages and discovery files are documented, but are not API operations.
          if (!location.pointer.includes("/paths/~1api~1v1")) return;
          const fail = (message) => report({ message, location });
          if (!/^[a-z][a-z0-9_]*$/.test(operation.operationId ?? "")) fail("operationId must be stable snake_case.");
          if (!operation.summary?.trim() || operation.summary.length > 80) fail("summary is required and must be at most 80 characters.");
          if (!operation.description?.trim() || operation.description.length >= 4096) fail("description is required and must be under 4096 characters.");
          const success = Object.entries(operation.responses ?? {}).filter(([code]) => /^2\d\d$/.test(code));
          if (!hasExample(operation.requestBody) && !success.some(([, response]) => hasExample(response)))
            fail("Provide a request or successful response example.");
          const errors = Object.entries(operation.responses ?? {}).filter(([code]) => /^(?:[45](?:\d\d|XX)|default)$/.test(code));
          if (!errors.length) fail("Document at least one error response.");
          for (const [, response] of errors) {
            if (!response.description?.trim() || !response.content?.["application/json"]?.schema) fail("Error responses need a description and JSON schema.");
          }
        },
      }),
    },
  },
};
