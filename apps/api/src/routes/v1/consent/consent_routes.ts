import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { get_consent_status } from '@/routes/v1/consent/get_consent_status';
import { get_consent_status_by_identifier } from '@/routes/v1/consent/get_consent_status_by_identifier';
import { accept_consent } from '@/routes/v1/consent/accept_consent';
import { get_profile_consent_status } from '@/routes/v1/consent/get_profile_consent_status';
import { accept_profile_consent } from '@/routes/v1/consent/accept_profile_consent';
import { u18_dob } from '@/routes/v1/consent/u18_dob';
import { u18_guardian } from '@/routes/v1/consent/u18_guardian';
import { u18_guardian_verify } from '@/routes/v1/consent/u18_guardian_verify';
import { u18_profile_consent } from '@/routes/v1/consent/u18_profile_consent';
import { u18_signup_guardian } from '@/routes/v1/consent/u18_signup_guardian';

const consent_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(get_consent_status);
  fastify.register(get_consent_status_by_identifier);
  fastify.register(accept_consent);
  fastify.register(get_profile_consent_status);
  fastify.register(accept_profile_consent);
  fastify.register(u18_dob);
  fastify.register(u18_guardian);
  fastify.register(u18_guardian_verify);
  fastify.register(u18_profile_consent);
  fastify.register(u18_signup_guardian);
};

export default consent_routes;
