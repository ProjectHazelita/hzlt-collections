import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { ErrorResponse } from '@hcl/contracts';
import { DomainError } from '@hcl/server';

/** Never serialize arbitrary exception messages, database diagnostics or request bodies. */
export function installErrors(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    let statusCode = 500;
    let code: ErrorResponse['error']['code'] = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let fields: Record<string, string> | undefined;

    if (error.name === 'SessionStoreError' && error.code === 'ENOENT') {
      statusCode = 401;
      code = 'SESSION_EXPIRED';
      message = 'Your session has expired.';
      // The plugin itself sets null on destroy, but its declaration omits null.
      const nullableRequest = request as { session: FastifyRequest['session'] | null };
      nullableRequest.session = null;
      reply.clearCookie('hzlt.sid', { path: '/' });
    } else if (error instanceof DomainError) {
      statusCode = error.statusCode;
      code = error.code as ErrorResponse['error']['code'];
      message = error.message;
      fields = error.fields;
    } else if (error.validation) {
      statusCode = 400;
      code = 'VALIDATION_ERROR';
      message = 'The request is invalid.';
      fields = {};
      for (const issue of error.validation) {
        const property = issue.params?.missingProperty;
        const location = issue.instancePath || error.validationContext || 'request';
        fields[typeof property === 'string' ? `${location}/${property}` : location] = 'Invalid value.';
      }
    } else if (error.statusCode === 429) {
      statusCode = 429;
      code = 'RATE_LIMITED';
      message = 'Too many requests. Please try again later.';
    } else if (error.statusCode === 404) {
      statusCode = 404;
      code = 'NOT_FOUND';
      message = 'The requested resource was not found.';
    } else if (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415) {
      statusCode = error.statusCode;
      code = 'VALIDATION_ERROR';
      message = error.statusCode === 413 ? 'The request is too large.' : 'The request is invalid.';
    }

    if (statusCode >= 500) {
      // Exception messages/stacks may contain SQL parameters or filesystem paths.
      request.log.error({ requestId: request.id, errorName: error.name, errorCode: error.code }, 'Request failed');
      code = 'INTERNAL_ERROR';
      message = 'An unexpected error occurred.';
      fields = undefined;
    }

    const response: ErrorResponse = { error: { code, message, requestId: request.id, ...(fields ? { fields } : {}) } };
    return reply.code(statusCode).send(response);
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId: request.id },
  } satisfies ErrorResponse));
}
