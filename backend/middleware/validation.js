/**
 * Joi-based request validation middleware.
 *
 * Usage:
 *   router.post('/login', validate({ body: loginSchema }), handler);
 */

import { ValidationError } from '../lib/errors.js';

function flatten(joiError) {
  return joiError.details.map((d) => ({
    path: d.path.join('.'),
    message: d.message.replace(/"/g, ''),
    type: d.type,
  }));
}

export function validate(schemas) {
  return (req, res, next) => {
    for (const key of ['body', 'query', 'params']) {
      const schema = schemas?.[key];
      if (!schema) continue;
      const { error, value } = schema.validate(req[key], {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
      });
      if (error) return next(new ValidationError(`Invalid ${key}`, flatten(error)));
      req[key] = value;
    }
    next();
  };
}

/** Strip null bytes from string values in req.body (defense against \0 attacks). */
export function stripNullBytes(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const k of Object.keys(req.body)) {
      if (typeof req.body[k] === 'string') {
        req.body[k] = req.body[k].replace(/\0/g, '');
      }
    }
  }
  next();
}
