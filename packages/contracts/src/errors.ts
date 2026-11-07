import { Type, type Static } from 'typebox';

export const ImageErrorCodeSchema = Type.Union([
  Type.Literal('UNSUPPORTED_IMAGE_TYPE'),
  Type.Literal('ANIMATION_NOT_SUPPORTED'),
  Type.Literal('IMAGE_TOO_LARGE'),
  Type.Literal('INVALID_IMAGE'),
  Type.Literal('IMAGE_TIMEOUT'),
  Type.Literal('IMAGE_PROCESSING_FAILED'),
]);
export type ImageErrorCode = Static<typeof ImageErrorCodeSchema>;

export const ErrorCodeSchema = Type.Union([
  Type.Literal('VALIDATION_ERROR'),
  Type.Literal('USERNAME_TAKEN'),
  Type.Literal('INVALID_CREDENTIALS'),
  Type.Literal('AUTH_REQUIRED'),
  Type.Literal('SESSION_EXPIRED'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('IDEMPOTENCY_CONFLICT'),
  Type.Literal('UPLOAD_NOT_READY'),
  Type.Literal('UPLOAD_EXPIRED'),
  Type.Literal('UPLOAD_ALREADY_USED'),
  Type.Literal('INTERNAL_ERROR'),
  ImageErrorCodeSchema,
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const ErrorFieldsSchema = Type.Record(Type.String(), Type.String());
export type ErrorFields = Static<typeof ErrorFieldsSchema>;
export const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: ErrorCodeSchema,
    message: Type.String(),
    requestId: Type.String(),
    fields: Type.Optional(ErrorFieldsSchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
