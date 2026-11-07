import { type Static, Type } from 'typebox';
import { ImageErrorCodeSchema } from './errors.js';
import { UuidSchema } from './primitives.js';

export const UploadAcceptedSchema = Type.Object(
  {
    id: UuidSchema,
    status: Type.Literal('pending'),
  },
  { additionalProperties: false },
);
export type UploadAccepted = Static<typeof UploadAcceptedSchema>;

export const UploadStatusSchema = Type.Object(
  {
    id: UuidSchema,
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
 * as a JSON body. Runtime multipart limits enforce one file and no text fields.
 */
export const UploadMultipartSchema = Type.Object(
  {
    file: Type.String({
      format: 'binary',
      description:
        'One static JPEG, PNG, WebP or GIF; actual bytes are inspected, not the supplied MIME type. SVG and animated images are rejected.',
    }),
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
