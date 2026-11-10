import { type Static, Type } from 'typebox';
import { ImageErrorCodeSchema } from './errors.js';
import { UuidSchema } from './primitives.js';

export const UploadKindSchema = Type.Union([Type.Literal('image'), Type.Literal('file')]);
export type UploadKind = Static<typeof UploadKindSchema>;

export const UploadAcceptedSchema = Type.Object(
  {
    id: UuidSchema,
    kind: UploadKindSchema,
    status: Type.Literal('pending'),
  },
  { additionalProperties: false },
);
export type UploadAccepted = Static<typeof UploadAcceptedSchema>;

export const UploadStatusSchema = Type.Object(
  {
    id: UuidSchema,
    kind: UploadKindSchema,
    name: Type.String({ maxLength: 255 }),
    status: Type.Union([Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]),
    errorCode: Type.Optional(ImageErrorCodeSchema),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type UploadStatus = Static<typeof UploadStatusSchema>;

/**
 * OpenAPI documentation only: multipart is consumed as a stream, not validated
 * as a JSON body. Runtime multipart limits enforce one file and at most one
 * `kind` text field.
 */
export const UploadMultipartSchema = Type.Object(
  {
    file: Type.String({
      format: 'binary',
      description:
        'One upload. With kind=image the bytes must be a static JPEG, PNG, WebP or GIF; with kind=file any bytes are stored and served as a download.',
    }),
    kind: Type.Optional(UploadKindSchema),
  },
  { additionalProperties: false },
);
export type UploadMultipart = Static<typeof UploadMultipartSchema>;

export const UploadRequestBodyDocumentation = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: UploadMultipartSchema,
    },
  },
} as const;
