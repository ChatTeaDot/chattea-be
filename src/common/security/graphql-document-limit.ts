import { GraphQLError, type ASTVisitor, type ValidationContext } from "graphql";

const MAX_GRAPHQL_DOCUMENT_FIELDS = 200;

export const graphqlDocumentFieldLimitRule = (context: ValidationContext): ASTVisitor => {
  let fieldCount = 0;
  let reported = false;

  return {
    Field: () => {
      fieldCount += 1;
      if (reported || fieldCount <= MAX_GRAPHQL_DOCUMENT_FIELDS) return;
      reported = true;
      context.reportError(new GraphQLError("GRAPHQL_DOCUMENT_FIELD_LIMIT_EXCEEDED"));
    },
  };
};
