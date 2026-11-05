// Contratos de developer.systeme.io, verificados 2026-10-10. Regenerar con scripts/generar-catalogo-systeme.mjs.
export const SYSTEME_OPERACIONES = [
 {
  "id": "DELETE /api/automation/rules/{id}",
  "metodo": "DELETE",
  "ruta": "/api/automation/rules/{id}",
  "dominio": "automation",
  "resumen": "Removes the AutomationRule resource.",
  "documentacion": "https://developer.systeme.io/reference/api_automationrules_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/booking-calendar/events/{eventId}",
  "metodo": "DELETE",
  "ruta": "/api/booking-calendar/events/{eventId}",
  "dominio": "booking-calendar",
  "resumen": "Removes the CalendarEvent resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendarevents_eventid_delete",
  "parametros": [
   {
    "nombre": "eventId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/community/memberships/{id}",
  "metodo": "DELETE",
  "ruta": "/api/community/memberships/{id}",
  "dominio": "community",
  "resumen": "Removes the Membership resource.",
  "documentacion": "https://developer.systeme.io/reference/api_communitymemberships_id_delete-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/contact_fields/{slug}",
  "metodo": "DELETE",
  "ruta": "/api/contact_fields/{slug}",
  "dominio": "contact_fields",
  "resumen": "Removes the ContactField resource.",
  "documentacion": "https://developer.systeme.io/reference/api_contact_fields_slug_delete-1",
  "parametros": [
   {
    "nombre": "slug",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/contacts/{id}",
  "metodo": "DELETE",
  "ruta": "/api/contacts/{id}",
  "dominio": "contacts",
  "resumen": "Removes the Contact resource.",
  "documentacion": "https://developer.systeme.io/reference/delete_contact-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/contacts/{id}/tags/{tagId}",
  "metodo": "DELETE",
  "ruta": "/api/contacts/{id}/tags/{tagId}",
  "dominio": "contacts",
  "resumen": "Removes a Tag from a Contact.",
  "documentacion": "https://developer.systeme.io/reference/delete_contact_tag-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "tagId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/mailing/campaign-steps/{id}",
  "metodo": "DELETE",
  "ruta": "/api/mailing/campaign-steps/{id}",
  "dominio": "mailing",
  "resumen": "Removes the CampaignStep resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaign-steps_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/mailing/campaigns/{id}",
  "metodo": "DELETE",
  "ruta": "/api/mailing/campaigns/{id}",
  "dominio": "mailing",
  "resumen": "Removes the Campaign resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/mailing/newsletters/{id}",
  "metodo": "DELETE",
  "ruta": "/api/mailing/newsletters/{id}",
  "dominio": "mailing",
  "resumen": "Removes the Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingnewsletters_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/payment/coupons/{id}",
  "metodo": "DELETE",
  "ruta": "/api/payment/coupons/{id}",
  "dominio": "payment",
  "resumen": "Removes the Coupon resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentcoupons_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/payment/digital-products/{id}",
  "metodo": "DELETE",
  "ruta": "/api/payment/digital-products/{id}",
  "dominio": "payment",
  "resumen": "Removes the DigitalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentdigital-products_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/payment/physical-products/{id}",
  "metodo": "DELETE",
  "ruta": "/api/payment/physical-products/{id}",
  "dominio": "payment",
  "resumen": "Removes the PhysicalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentphysical-products_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/payment/price-plans/{id}",
  "metodo": "DELETE",
  "ruta": "/api/payment/price-plans/{id}",
  "dominio": "payment",
  "resumen": "Removes the PricePlan resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentprice-plans_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/school/course-modules/{moduleId}",
  "metodo": "DELETE",
  "ruta": "/api/school/course-modules/{moduleId}",
  "dominio": "school",
  "resumen": "Removes the Module resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourse-modules_moduleid_delete",
  "parametros": [
   {
    "nombre": "moduleId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/school/courses/{id}",
  "metodo": "DELETE",
  "ruta": "/api/school/courses/{id}",
  "dominio": "school",
  "resumen": "Removes the Course resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_id_delete",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/school/enrollments/{id}",
  "metodo": "DELETE",
  "ruta": "/api/school/enrollments/{id}",
  "dominio": "school",
  "resumen": "Removes the Enrollment resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolenrollments_id_delete-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/school/lectures/{lectureId}",
  "metodo": "DELETE",
  "ruta": "/api/school/lectures/{lectureId}",
  "dominio": "school",
  "resumen": "Removes the Lecture resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoollectures_lectureid_delete",
  "parametros": [
   {
    "nombre": "lectureId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/sms/templates/{templateId}",
  "metodo": "DELETE",
  "ruta": "/api/sms/templates/{templateId}",
  "dominio": "sms",
  "resumen": "Removes the SmsTemplate resource.",
  "documentacion": "https://developer.systeme.io/reference/api_smstemplates_templateid_delete",
  "parametros": [
   {
    "nombre": "templateId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "DELETE /api/tags/{id}",
  "metodo": "DELETE",
  "ruta": "/api/tags/{id}",
  "dominio": "tags",
  "resumen": "Removes the Tag resource.",
  "documentacion": "https://developer.systeme.io/reference/api_tags_id_delete-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "DELETE /api/webhooks/{id}",
  "metodo": "DELETE",
  "ruta": "/api/webhooks/{id}",
  "dominio": "webhooks",
  "resumen": "Removes the Webhook resource.",
  "documentacion": "https://developer.systeme.io/reference/api_webhooks_id_delete-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/automation/rules",
  "metodo": "GET",
  "ruta": "/api/automation/rules",
  "dominio": "automation",
  "resumen": "Retrieves the collection of AutomationRule resources.",
  "documentacion": "https://developer.systeme.io/reference/api_automationrules_get_collection",
  "parametros": [
   {
    "nombre": "triggerType",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "tag_added",
      "tag_removed",
      "form_subscribed",
      "booking_created",
      "campaign_completed",
      "enrolled_in_course",
      "course_completed",
      "module_completed",
      "lecture_completed",
      "new_sale",
      "sale_canceled",
      "subscription_payment_failed",
      "page_visited"
     ]
    }
   },
   {
    "nombre": "triggerTagId",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer"
    }
   },
   {
    "nombre": "triggerFunnelStepId",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer"
    }
   },
   {
    "nombre": "actionType",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "add_tag",
      "remove_tag",
      "unsubscribe_from_campaign",
      "send_sms",
      "send_webhook",
      "enroll_in_course",
      "revoke_access_to_course"
     ]
    }
   },
   {
    "nombre": "actionTagId",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer"
    }
   },
   {
    "nombre": "active",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "boolean"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/automation/rules/{id}",
  "metodo": "GET",
  "ruta": "/api/automation/rules/{id}",
  "dominio": "automation",
  "resumen": "Retrieves a AutomationRule resource.",
  "documentacion": "https://developer.systeme.io/reference/api_automationrules_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/booking-calendar/bookings",
  "metodo": "GET",
  "ruta": "/api/booking-calendar/bookings",
  "dominio": "booking-calendar",
  "resumen": "Retrieves the collection of Booking resources.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendarbookings_get_collection",
  "parametros": [
   {
    "nombre": "eventId",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer"
    }
   },
   {
    "nombre": "startDate",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "endDate",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "status",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "SCHEDULED",
      "UPCOMING",
      "PAST",
      "RESCHEDULED",
      "CANCELLED"
     ]
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/booking-calendar/events",
  "metodo": "GET",
  "ruta": "/api/booking-calendar/events",
  "dominio": "booking-calendar",
  "resumen": "Retrieves the collection of Event resources.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendarevents_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/booking-calendar/events/{eventId}",
  "metodo": "GET",
  "ruta": "/api/booking-calendar/events/{eventId}",
  "dominio": "booking-calendar",
  "resumen": "Retrieves a CalendarEvent resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendarevents_eventid_get",
  "parametros": [
   {
    "nombre": "eventId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/booking-calendar/user-availability",
  "metodo": "GET",
  "ruta": "/api/booking-calendar/user-availability",
  "dominio": "booking-calendar",
  "resumen": "Retrieves a UserAvailability resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendaruser-availability_get",
  "parametros": []
 },
 {
  "id": "GET /api/community/communities",
  "metodo": "GET",
  "ruta": "/api/community/communities",
  "dominio": "community",
  "resumen": "Retrieves the collection of Community resources.",
  "documentacion": "https://developer.systeme.io/reference/api_communitycommunities_get_collection-1",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/community/memberships",
  "metodo": "GET",
  "ruta": "/api/community/memberships",
  "dominio": "community",
  "resumen": "Retrieves the collection of Membership resources.",
  "documentacion": "https://developer.systeme.io/reference/api_communitymemberships_get_collection-1",
  "parametros": [
   {
    "nombre": "community",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer"
    }
   },
   {
    "nombre": "contact",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/contact_fields",
  "metodo": "GET",
  "ruta": "/api/contact_fields",
  "dominio": "contact_fields",
  "resumen": "Retrieves the collection of ContactField resources.",
  "documentacion": "https://developer.systeme.io/reference/api_contact_fields_get_collection-1",
  "parametros": []
 },
 {
  "id": "GET /api/contacts",
  "metodo": "GET",
  "ruta": "/api/contacts",
  "dominio": "contacts",
  "resumen": "Retrieves the collection of Contact resources.",
  "documentacion": "https://developer.systeme.io/reference/api_contacts_get_collection-1",
  "parametros": [
   {
    "nombre": "email",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "tags",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "bounced",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "boolean"
    }
   },
   {
    "nombre": "unsubscribed",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "boolean"
    }
   },
   {
    "nombre": "needsConfirmation",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "boolean"
    }
   },
   {
    "nombre": "registeredBefore",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "format": "date-time"
    }
   },
   {
    "nombre": "registeredAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "format": "date-time"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/contacts/{id}",
  "metodo": "GET",
  "ruta": "/api/contacts/{id}",
  "dominio": "contacts",
  "resumen": "Retrieves a Contact resource.",
  "documentacion": "https://developer.systeme.io/reference/api_contacts_id_get-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/domains",
  "metodo": "GET",
  "ruta": "/api/domains",
  "dominio": "domains",
  "resumen": "Retrieves the collection of Domain resources.",
  "documentacion": "https://developer.systeme.io/reference/api_domains_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "workableOnly",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "boolean"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/files",
  "metodo": "GET",
  "ruta": "/api/files",
  "dominio": "files",
  "resumen": "Retrieves the collection of File resources.",
  "documentacion": "https://developer.systeme.io/reference/api_files_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "types",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/funnel-steps/{id}",
  "metodo": "GET",
  "ruta": "/api/funnel-steps/{id}",
  "dominio": "funnel-steps",
  "resumen": "Retrieves a FunnelStep resource.",
  "documentacion": "https://developer.systeme.io/reference/api_funnel-steps_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/funnels",
  "metodo": "GET",
  "ruta": "/api/funnels",
  "dominio": "funnels",
  "resumen": "Retrieves the collection of Funnel resources.",
  "documentacion": "https://developer.systeme.io/reference/api_funnels_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/funnels/{funnelId}/steps",
  "metodo": "GET",
  "ruta": "/api/funnels/{funnelId}/steps",
  "dominio": "funnels",
  "resumen": "Retrieves the collection of FunnelStep resources.",
  "documentacion": "https://developer.systeme.io/reference/api_funnels_funnelidsteps_get_collection",
  "parametros": [
   {
    "nombre": "funnelId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/funnels/{id}",
  "metodo": "GET",
  "ruta": "/api/funnels/{id}",
  "dominio": "funnels",
  "resumen": "Retrieves a Funnel resource.",
  "documentacion": "https://developer.systeme.io/reference/api_funnels_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/funnels/steps",
  "metodo": "GET",
  "ruta": "/api/funnels/steps",
  "dominio": "funnels",
  "resumen": "Retrieves the collection of FunnelStepSearchResult resources.",
  "documentacion": "https://developer.systeme.io/reference/api_funnelssteps_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "funnelId",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "types",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/automation-emails",
  "metodo": "GET",
  "ruta": "/api/mailing/automation-emails",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of AutomationEmail resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/automation-emails-to-specific-address",
  "metodo": "GET",
  "ruta": "/api/mailing/automation-emails-to-specific-address",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of AutomationEmailToSpecificAddress resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails-to-specific-address_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/automation-emails-to-specific-address/{id}",
  "metodo": "GET",
  "ruta": "/api/mailing/automation-emails-to-specific-address/{id}",
  "dominio": "mailing",
  "resumen": "Retrieves a AutomationEmailToSpecificAddress resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails-to-specific-address_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/automation-emails/{id}",
  "metodo": "GET",
  "ruta": "/api/mailing/automation-emails/{id}",
  "dominio": "mailing",
  "resumen": "Retrieves a AutomationEmail resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/automation-emails/{id}/statistics",
  "metodo": "GET",
  "ruta": "/api/mailing/automation-emails/{id}/statistics",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieves a AutomationEmail resource.",
  "documentacion": "https://developer.systeme.io/reference/automation_email_statistics",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/campaign-steps/{id}",
  "metodo": "GET",
  "ruta": "/api/mailing/campaign-steps/{id}",
  "dominio": "mailing",
  "resumen": "Retrieves a CampaignStep resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaign-steps_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/campaign-steps/{id}/statistics",
  "metodo": "GET",
  "ruta": "/api/mailing/campaign-steps/{id}/statistics",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieves a CampaignStep resource.",
  "documentacion": "https://developer.systeme.io/reference/campaign_step_statistics",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/campaigns",
  "metodo": "GET",
  "ruta": "/api/mailing/campaigns",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of Campaign resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/campaigns/{campaignId}/steps",
  "metodo": "GET",
  "ruta": "/api/mailing/campaigns/{campaignId}/steps",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of CampaignStep resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_campaignidsteps_get_collection",
  "parametros": [
   {
    "nombre": "campaignId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/campaigns/{id}",
  "metodo": "GET",
  "ruta": "/api/mailing/campaigns/{id}",
  "dominio": "mailing",
  "resumen": "Retrieves a Campaign resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/newsletters",
  "metodo": "GET",
  "ruta": "/api/mailing/newsletters",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of Newsletter resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingnewsletters_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/newsletters/{id}",
  "metodo": "GET",
  "ruta": "/api/mailing/newsletters/{id}",
  "dominio": "mailing",
  "resumen": "Retrieves a Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingnewsletters_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/newsletters/{id}/excluded-tags",
  "metodo": "GET",
  "ruta": "/api/mailing/newsletters/{id}/excluded-tags",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of MailingTag resources.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_excluded_tags_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/newsletters/{id}/included-tags",
  "metodo": "GET",
  "ruta": "/api/mailing/newsletters/{id}/included-tags",
  "dominio": "mailing",
  "resumen": "Retrieves the collection of MailingTag resources.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_included_tags_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/newsletters/{id}/schedule",
  "metodo": "GET",
  "ruta": "/api/mailing/newsletters/{id}/schedule",
  "dominio": "mailing",
  "resumen": "Retrieves a NewsletterSchedule resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_schedule_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/newsletters/{id}/statistics",
  "metodo": "GET",
  "ruta": "/api/mailing/newsletters/{id}/statistics",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieves a Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_statistics",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/statistics/automation-emails",
  "metodo": "GET",
  "ruta": "/api/mailing/statistics/automation-emails",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieves the collection of AutomationEmailStatisticsListItem resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingstatisticsautomation-emails_get_collection",
  "parametros": [
   {
    "nombre": "dateFrom",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "dateTo",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/statistics/automation-emails/summary",
  "metodo": "GET",
  "ruta": "/api/mailing/statistics/automation-emails/summary",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieve automation email statistics overview",
  "documentacion": "https://developer.systeme.io/reference/mailing_automation_email_statistics_overview_get",
  "parametros": [
   {
    "nombre": "dateFrom",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "dateTo",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/statistics/campaign-steps",
  "metodo": "GET",
  "ruta": "/api/mailing/statistics/campaign-steps",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieves the collection of CampaignStepStatisticsListItem resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingstatisticscampaign-steps_get_collection",
  "parametros": [
   {
    "nombre": "dateFrom",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "dateTo",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/statistics/campaign-steps/summary",
  "metodo": "GET",
  "ruta": "/api/mailing/statistics/campaign-steps/summary",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieve campaign step statistics overview",
  "documentacion": "https://developer.systeme.io/reference/mailing_campaign_step_statistics_overview_get",
  "parametros": [
   {
    "nombre": "dateFrom",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "dateTo",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/statistics/newsletters",
  "metodo": "GET",
  "ruta": "/api/mailing/statistics/newsletters",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieves the collection of NewsletterStatisticsListItem resources.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingstatisticsnewsletters_get_collection",
  "parametros": [
   {
    "nombre": "dateFrom",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "dateTo",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/mailing/statistics/newsletters/summary",
  "metodo": "GET",
  "ruta": "/api/mailing/statistics/newsletters/summary",
  "dominio": "mailing",
  "resumen": "[Beta] Retrieve newsletter statistics overview",
  "documentacion": "https://developer.systeme.io/reference/mailing_newsletter_statistics_overview_get",
  "parametros": [
   {
    "nombre": "dateFrom",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   },
   {
    "nombre": "dateTo",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "date"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/coupons",
  "metodo": "GET",
  "ruta": "/api/payment/coupons",
  "dominio": "payment",
  "resumen": "Retrieves the collection of Coupon resources.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentcoupons_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/coupons/{id}",
  "metodo": "GET",
  "ruta": "/api/payment/coupons/{id}",
  "dominio": "payment",
  "resumen": "Retrieves a Coupon resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentcoupons_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/digital-products",
  "metodo": "GET",
  "ruta": "/api/payment/digital-products",
  "dominio": "payment",
  "resumen": "Retrieves the collection of DigitalProduct resources.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentdigital-products_get_collection",
  "parametros": [
   {
    "nombre": "currency",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "aud",
      "cad",
      "dkk",
      "eur",
      "hkd",
      "ils",
      "jpy",
      "mxn",
      "nzd",
      "nok",
      "php",
      "pln",
      "gbp",
      "rub",
      "sgd",
      "sek",
      "chf",
      "thb",
      "usd",
      "brl",
      "inr",
      "myr",
      "czk",
      "ron",
      "aed",
      "huf",
      "cop",
      "xaf",
      "clp",
      "egp",
      "ghs",
      "gnf",
      "kes",
      "mwk",
      "mad",
      "ngn",
      "rwf",
      "sll",
      "std",
      "zar",
      "tzs",
      "ugx",
      "xof",
      "zmw",
      "bgn",
      "isk",
      "try",
      "ars",
      "sar",
      "idr",
      "lkr",
      "cny",
      "rsd",
      "uah",
      "all",
      "vnd",
      "pen",
      "twd"
     ]
    }
   },
   {
    "nombre": "source",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "digital-store",
      "funnel",
      "Whitelabel"
     ]
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/digital-products/{id}",
  "metodo": "GET",
  "ruta": "/api/payment/digital-products/{id}",
  "dominio": "payment",
  "resumen": "Retrieves a DigitalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentdigital-products_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/offers/{id}",
  "metodo": "GET",
  "ruta": "/api/payment/offers/{id}",
  "dominio": "payment",
  "resumen": "Retrieves a Offer resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentoffers_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/physical-products",
  "metodo": "GET",
  "ruta": "/api/payment/physical-products",
  "dominio": "payment",
  "resumen": "Retrieves the collection of PhysicalProduct resources.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentphysical-products_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/physical-products/{id}",
  "metodo": "GET",
  "ruta": "/api/payment/physical-products/{id}",
  "dominio": "payment",
  "resumen": "Retrieves a PhysicalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentphysical-products_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/price-plans",
  "metodo": "GET",
  "ruta": "/api/payment/price-plans",
  "dominio": "payment",
  "resumen": "Retrieves the collection of PricePlan resources.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentprice-plans_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/price-plans/{id}",
  "metodo": "GET",
  "ruta": "/api/payment/price-plans/{id}",
  "dominio": "payment",
  "resumen": "Retrieves a PricePlan resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentprice-plans_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/sale-settings/{externalId}",
  "metodo": "GET",
  "ruta": "/api/payment/sale-settings/{externalId}",
  "dominio": "payment",
  "resumen": "Retrieves a SaleSettings resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentsale-settings_externalid_get",
  "parametros": [
   {
    "nombre": "externalId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "uuid"
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/sale-settings/payment-methods/{currency}",
  "metodo": "GET",
  "ruta": "/api/payment/sale-settings/payment-methods/{currency}",
  "dominio": "payment",
  "resumen": "Retrieves a AvailablePaymentMethods resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentsale-settingspayment-methods_currency_get",
  "parametros": [
   {
    "nombre": "currency",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string",
     "enum": [
      "aud",
      "cad",
      "dkk",
      "eur",
      "hkd",
      "ils",
      "jpy",
      "mxn",
      "nzd",
      "nok",
      "php",
      "pln",
      "gbp",
      "rub",
      "sgd",
      "sek",
      "chf",
      "thb",
      "usd",
      "brl",
      "inr",
      "myr",
      "czk",
      "ron",
      "aed",
      "huf",
      "cop",
      "xaf",
      "clp",
      "egp",
      "ghs",
      "gnf",
      "kes",
      "mwk",
      "mad",
      "ngn",
      "rwf",
      "sll",
      "std",
      "zar",
      "tzs",
      "ugx",
      "xof",
      "zmw",
      "bgn",
      "isk",
      "try",
      "ars",
      "sar",
      "idr",
      "lkr",
      "cny",
      "rsd",
      "uah",
      "all",
      "vnd",
      "pen",
      "twd"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/payment/subscriptions",
  "metodo": "GET",
  "ruta": "/api/payment/subscriptions",
  "dominio": "payment",
  "resumen": "Retrieves the collection of Subscription resources.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentsubscriptions_get_collection-1",
  "parametros": [
   {
    "nombre": "contact",
    "en": "query",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/school/course-modules",
  "metodo": "GET",
  "ruta": "/api/school/course-modules",
  "dominio": "school",
  "resumen": "Retrieves the collection of Module resources.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourse-modules_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "courseId",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/school/course-modules/{moduleId}",
  "metodo": "GET",
  "ruta": "/api/school/course-modules/{moduleId}",
  "dominio": "school",
  "resumen": "Retrieves a Module resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourse-modules_moduleid_get",
  "parametros": [
   {
    "nombre": "moduleId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/school/course-themes",
  "metodo": "GET",
  "ruta": "/api/school/course-themes",
  "dominio": "school",
  "resumen": "Retrieves the collection of CourseTheme resources.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourse-themes_get_collection",
  "parametros": [
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/school/courses",
  "metodo": "GET",
  "ruta": "/api/school/courses",
  "dominio": "school",
  "resumen": "Retrieves the collection of Course resources.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_get_collection-1",
  "parametros": [
   {
    "nombre": "active",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "boolean"
    }
   },
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/school/courses/{courseId}/modules-with-lectures",
  "metodo": "GET",
  "ruta": "/api/school/courses/{courseId}/modules-with-lectures",
  "dominio": "school",
  "resumen": "Retrieves the collection of CourseModulesWithLectures resources.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_courseidmodules-with-lectures_get_collection",
  "parametros": [
   {
    "nombre": "courseId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/school/courses/{id}",
  "metodo": "GET",
  "ruta": "/api/school/courses/{id}",
  "dominio": "school",
  "resumen": "Retrieves a Course resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_id_get",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/school/enrollments",
  "metodo": "GET",
  "ruta": "/api/school/enrollments",
  "dominio": "school",
  "resumen": "Retrieves the collection of Enrollment resources.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolenrollments_get_collection-1",
  "parametros": [
   {
    "nombre": "course",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "contact",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/school/lectures/{lectureId}",
  "metodo": "GET",
  "ruta": "/api/school/lectures/{lectureId}",
  "dominio": "school",
  "resumen": "Retrieves a Lecture resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoollectures_lectureid_get",
  "parametros": [
   {
    "nombre": "lectureId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/sms/message-services",
  "metodo": "GET",
  "ruta": "/api/sms/message-services",
  "dominio": "sms",
  "resumen": "Retrieves the collection of SmsMessageService resources.",
  "documentacion": "https://developer.systeme.io/reference/api_smsmessage-services_get_collection",
  "parametros": []
 },
 {
  "id": "GET /api/sms/phone-numbers",
  "metodo": "GET",
  "ruta": "/api/sms/phone-numbers",
  "dominio": "sms",
  "resumen": "Retrieves a SmsPhoneNumbers resource.",
  "documentacion": "https://developer.systeme.io/reference/api_smsphone-numbers_get",
  "parametros": []
 },
 {
  "id": "GET /api/sms/templates",
  "metodo": "GET",
  "ruta": "/api/sms/templates",
  "dominio": "sms",
  "resumen": "Retrieves the collection of SmsTemplate resources.",
  "documentacion": "https://developer.systeme.io/reference/api_smstemplates_get_collection",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/sms/templates/{templateId}",
  "metodo": "GET",
  "ruta": "/api/sms/templates/{templateId}",
  "dominio": "sms",
  "resumen": "Retrieves a SmsTemplate resource.",
  "documentacion": "https://developer.systeme.io/reference/api_smstemplates_templateid_get",
  "parametros": [
   {
    "nombre": "templateId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "GET /api/sms/twilio-account",
  "metodo": "GET",
  "ruta": "/api/sms/twilio-account",
  "dominio": "sms",
  "resumen": "Retrieves a SmsTwilioAccount resource.",
  "documentacion": "https://developer.systeme.io/reference/api_smstwilio-account_get",
  "parametros": []
 },
 {
  "id": "GET /api/tags",
  "metodo": "GET",
  "ruta": "/api/tags",
  "dominio": "tags",
  "resumen": "Retrieves the collection of Tag resources.",
  "documentacion": "https://developer.systeme.io/reference/api_tags_get_collection-1",
  "parametros": [
   {
    "nombre": "query",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string"
    }
   },
   {
    "nombre": "limit",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 10,
     "maximum": 100
    }
   },
   {
    "nombre": "startingAfter",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   },
   {
    "nombre": "order",
    "en": "query",
    "requerido": false,
    "esquema": {
     "type": "string",
     "enum": [
      "asc",
      "desc"
     ]
    }
   }
  ]
 },
 {
  "id": "GET /api/tags/{id}",
  "metodo": "GET",
  "ruta": "/api/tags/{id}",
  "dominio": "tags",
  "resumen": "Retrieves a Tag resource.",
  "documentacion": "https://developer.systeme.io/reference/api_tags_id_get-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "GET /api/webhooks",
  "metodo": "GET",
  "ruta": "/api/webhooks",
  "dominio": "webhooks",
  "resumen": "Retrieves the collection of Webhook resources.",
  "documentacion": "https://developer.systeme.io/reference/api_webhooks_get_collection-1",
  "parametros": []
 },
 {
  "id": "GET /api/webhooks/{id}",
  "metodo": "GET",
  "ruta": "/api/webhooks/{id}",
  "dominio": "webhooks",
  "resumen": "Retrieves a Webhook resource.",
  "documentacion": "https://developer.systeme.io/reference/api_webhooks_id_get-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ]
 },
 {
  "id": "PATCH /api/automation/rules/{id}",
  "metodo": "PATCH",
  "ruta": "/api/automation/rules/{id}",
  "dominio": "automation",
  "resumen": "Updates the AutomationRule resource.",
  "documentacion": "https://developer.systeme.io/reference/api_automationrules_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "triggers": {
      "type": "array",
      "items": {
       "oneOf": [
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "tag_added"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "tag_removed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "form_subscribed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "booking_created"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "bookingEventId"
           ],
           "additionalProperties": false,
           "properties": {
            "bookingEventId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "campaign_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "campaignId"
           ],
           "additionalProperties": false,
           "properties": {
            "campaignId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "enrolled_in_course"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "course_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "module_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "moduleId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "lecture_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "moduleId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "lectureId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "new_sale"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "sale_canceled"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "subscription_payment_failed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "page_visited"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        }
       ]
      }
     },
     "actions": {
      "type": "array",
      "items": {
       "oneOf": [
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "add_tag"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "remove_tag"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_email"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "automationEmailId"
           ],
           "additionalProperties": false,
           "properties": {
            "automationEmailId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_email_to_specific_address"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "automationEmailToSpecificAddressId"
           ],
           "additionalProperties": false,
           "properties": {
            "automationEmailToSpecificAddressId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "subscribe_to_campaign"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "campaignId"
           ],
           "additionalProperties": false,
           "properties": {
            "campaignId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "unsubscribe_from_campaign"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "campaignId"
           ],
           "additionalProperties": false,
           "properties": {
            "campaignId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_sms"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "smsTemplateId"
           ],
           "additionalProperties": false,
           "properties": {
            "smsTemplateId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_webhook"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "webhookUrl"
           ],
           "additionalProperties": false,
           "properties": {
            "webhookUrl": {
             "type": "string",
             "format": "uri"
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "enroll_in_course"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId",
            "courseAccessType"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "courseAccessType": {
             "type": "string",
             "enum": [
              "full_access",
              "partial_access",
              "dripping_content",
              "partial_dripping_access"
             ]
            },
            "courseModuleIds": {
             "type": [
              "array",
              "null"
             ],
             "items": {
              "type": "integer",
              "minimum": 1
             }
            }
           },
           "allOf": [
            {
             "oneOf": [
              {
               "required": [
                "courseAccessType",
                "courseModuleIds"
               ],
               "properties": {
                "courseAccessType": {
                 "enum": [
                  "partial_access",
                  "partial_dripping_access"
                 ]
                },
                "courseModuleIds": {
                 "type": "array"
                }
               }
              },
              {
               "required": [
                "courseAccessType"
               ],
               "properties": {
                "courseAccessType": {
                 "enum": [
                  "full_access",
                  "dripping_content"
                 ]
                },
                "courseModuleIds": {
                 "type": [
                  "array",
                  "null"
                 ]
                }
               }
              }
             ]
            }
           ]
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "revoke_access_to_course"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        }
       ]
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/booking-calendar/events/{eventId}",
  "metodo": "PATCH",
  "ruta": "/api/booking-calendar/events/{eventId}",
  "dominio": "booking-calendar",
  "resumen": "Updates the CalendarEvent resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendarevents_eventid_patch",
  "parametros": [
   {
    "nombre": "eventId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 255
     },
     "eventDuration": {
      "type": "integer"
     },
     "description": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 5000
     },
     "googleCalendarId": {
      "type": [
       "string",
       "null"
      ]
     },
     "googleIntegrationId": {
      "type": [
       "string",
       "null"
      ]
     },
     "farOutBookRange": {
      "type": [
       "integer",
       "null"
      ],
      "minimum": 0,
      "maximum": 365
     },
     "nearestBookRange": {
      "type": [
       "integer",
       "null"
      ]
     },
     "cancellationDeadline": {
      "type": [
       "integer",
       "null"
      ],
      "maximum": 31536000
     },
     "maxParticipants": {
      "type": [
       "integer",
       "null"
      ]
     },
     "startTimeIncrement": {
      "type": "integer"
     },
     "bookingBufferTime": {
      "type": [
       "integer",
       "null"
      ]
     },
     "displayTimezoneType": {
      "type": "string",
      "enum": [
       "FIXED",
       "LOCAL"
      ]
     },
     "dateRangeMode": {
      "type": "string",
      "enum": [
       "FAR_OUT_BOOK_RANGE",
       "RANGE",
       "INDEFINITE"
      ]
     },
     "displayTimezone": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 255
     },
     "hostName": {
      "type": "string",
      "maxLength": 255
     },
     "hostAvatarUrl": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 2000
     },
     "customLogo": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 2000
     },
     "startDate": {
      "type": [
       "string",
       "null"
      ]
     },
     "endDate": {
      "type": [
       "string",
       "null"
      ]
     },
     "locations": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "locationType"
       ],
       "properties": {
        "locationType": {
         "type": "string",
         "enum": [
          "PERSONAL",
          "ZOOM",
          "ONLINE_MEETING",
          "PHONE",
          "GOOGLE_MEET"
         ]
        },
        "description": {
         "type": [
          "string",
          "null"
         ],
         "maxLength": 500
        },
        "meetingLink": {
         "type": [
          "string",
          "null"
         ],
         "maxLength": 500,
         "format": "uri"
        },
        "phone": {
         "type": [
          "string",
          "null"
         ]
        },
        "address": {
         "type": [
          "string",
          "null"
         ],
         "maxLength": 255
        }
       }
      }
     },
     "maxBookingsPerDay": {
      "type": [
       "integer",
       "null"
      ]
     },
     "useGlobalAvailability": {
      "type": "boolean"
     },
     "localUserAvailability": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "weeklyDailySettings": {
          "type": [
           "array",
           "null"
          ],
          "items": {
           "type": "object",
           "required": [
            "startTime",
            "endTime"
           ],
           "properties": {
            "dayOfWeek": {
             "type": [
              "string",
              "null"
             ],
             "enum": [
              "MONDAY",
              "TUESDAY",
              "WEDNESDAY",
              "THURSDAY",
              "FRIDAY",
              "SATURDAY",
              "SUNDAY",
              null
             ]
            },
            "date": {
             "type": [
              "string",
              "null"
             ]
            },
            "startTime": {
             "type": "integer"
            },
            "endTime": {
             "type": "integer"
            }
           }
          }
         },
         "dateSpecificDailySettings": {
          "type": [
           "array",
           "null"
          ],
          "items": {
           "type": "object",
           "required": [
            "startTime",
            "endTime"
           ],
           "properties": {
            "dayOfWeek": {
             "type": [
              "string",
              "null"
             ],
             "enum": [
              "MONDAY",
              "TUESDAY",
              "WEDNESDAY",
              "THURSDAY",
              "FRIDAY",
              "SATURDAY",
              "SUNDAY",
              null
             ]
            },
            "date": {
             "type": [
              "string",
              "null"
             ]
            },
            "startTime": {
             "type": "integer"
            },
            "endTime": {
             "type": "integer"
            }
           }
          }
         }
        }
       },
       {
        "type": "null"
       }
      ]
     },
     "reminderSettings": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "seconds"
       ],
       "properties": {
        "id": {
         "type": [
          "integer",
          "null"
         ]
        },
        "seconds": {
         "type": "integer",
         "minimum": 600
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/booking-calendar/user-availability",
  "metodo": "PATCH",
  "ruta": "/api/booking-calendar/user-availability",
  "dominio": "booking-calendar",
  "resumen": "Updates the UserAvailability resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendaruser-availability_patch",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "weeklyDailySettings": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "startTime",
        "endTime"
       ],
       "properties": {
        "dayOfWeek": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
          null
         ]
        },
        "date": {
         "type": [
          "string",
          "null"
         ]
        },
        "startTime": {
         "type": "integer"
        },
        "endTime": {
         "type": "integer"
        }
       }
      }
     },
     "dateSpecificDailySettings": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "startTime",
        "endTime"
       ],
       "properties": {
        "dayOfWeek": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
          null
         ]
        },
        "date": {
         "type": [
          "string",
          "null"
         ]
        },
        "startTime": {
         "type": "integer"
        },
        "endTime": {
         "type": "integer"
        }
       }
      }
     },
     "unavailabilityRanges": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "startDate",
        "endDate"
       ],
       "properties": {
        "startDate": {
         "type": "string"
        },
        "endDate": {
         "type": "string"
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/contact_fields/{slug}",
  "metodo": "PATCH",
  "ruta": "/api/contact_fields/{slug}",
  "dominio": "contact_fields",
  "resumen": "Updates the ContactField resource.",
  "documentacion": "https://developer.systeme.io/reference/api_contact_fields_slug_patch-1",
  "parametros": [
   {
    "nombre": "slug",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "required": [
     "fieldName"
    ],
    "properties": {
     "fieldName": {
      "type": "string",
      "maxLength": 255
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/contacts/{id}",
  "metodo": "PATCH",
  "ruta": "/api/contacts/{id}",
  "dominio": "contacts",
  "resumen": "Updates the Contact resource.",
  "documentacion": "https://developer.systeme.io/reference/api_contacts_id_patch-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "locale": {
      "type": [
       "string",
       "null"
      ],
      "enum": [
       "en",
       "fr",
       "es",
       "it",
       "pt",
       "de",
       "nl",
       "ru",
       "jp",
       "tr",
       "ar",
       "zh",
       "sv",
       "ro",
       "cs",
       "hu",
       "sk",
       "dk",
       "id",
       "pl",
       "el",
       "sr",
       "hi",
       "no",
       "th",
       "sq",
       "sl",
       "ua"
      ]
     },
     "fields": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "slug": {
         "type": "string"
        },
        "value": {
         "type": [
          "string",
          "null"
         ]
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/mailing/automation-emails-to-specific-address/{id}",
  "metodo": "PATCH",
  "ruta": "/api/mailing/automation-emails-to-specific-address/{id}",
  "dominio": "mailing",
  "resumen": "Updates the AutomationEmailToSpecificAddress resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails-to-specific-address_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "recipientAddress": {
      "type": "string",
      "format": "email"
     },
     "content": {
      "type": "object",
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ]
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": [
         "object",
         "null"
        ]
       },
       "senderEmail": {
        "type": "string",
        "format": "email"
       },
       "senderName": {
        "type": "string"
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/mailing/automation-emails/{id}",
  "metodo": "PATCH",
  "ruta": "/api/mailing/automation-emails/{id}",
  "dominio": "mailing",
  "resumen": "Updates the AutomationEmail resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "content": {
      "type": "object",
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ]
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": [
         "object",
         "null"
        ]
       },
       "senderEmail": {
        "type": "string",
        "format": "email"
       },
       "senderName": {
        "type": "string"
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/mailing/campaign-steps/{id}",
  "metodo": "PATCH",
  "ruta": "/api/mailing/campaign-steps/{id}",
  "dominio": "mailing",
  "resumen": "Updates the CampaignStep resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaign-steps_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "comment": {
      "type": [
       "string",
       "null"
      ]
     },
     "content": {
      "type": "object",
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ]
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": "object",
        "nullable": true
       },
       "senderEmail": {
        "type": "string",
        "format": "email"
       },
       "senderName": {
        "type": "string"
       }
      }
     },
     "activation": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "afterStepId": {
          "type": [
           "integer",
           "null"
          ]
         },
         "delay": {
          "anyOf": [
           {
            "type": "object",
            "required": [
             "value",
             "unit"
            ],
            "properties": {
             "value": {
              "type": "integer"
             },
             "unit": {
              "type": "string",
              "enum": [
               "minute",
               "hour",
               "day"
              ]
             }
            }
           },
           {
            "type": "null"
           }
          ]
         },
         "sendAtLocalTime": {
          "type": [
           "string",
           "null"
          ]
         },
         "skipWeekdays": {
          "type": "array",
          "items": {
           "type": "string",
           "enum": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday"
           ]
          }
         }
        }
       },
       {
        "type": "null"
       }
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/mailing/campaigns/{id}",
  "metodo": "PATCH",
  "ruta": "/api/mailing/campaigns/{id}",
  "dominio": "mailing",
  "resumen": "Updates the Campaign resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string"
     },
     "senderEmail": {
      "type": "string"
     },
     "description": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 2000
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/mailing/newsletters/{id}",
  "metodo": "PATCH",
  "ruta": "/api/mailing/newsletters/{id}",
  "dominio": "mailing",
  "resumen": "Updates the Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingnewsletters_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "required": [
     "content"
    ],
    "properties": {
     "content": {
      "type": "object",
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ]
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": [
         "array",
         "null"
        ],
        "items": {
         "type": "string"
        }
       },
       "senderEmail": {
        "type": "string",
        "format": "email"
       },
       "senderName": {
        "type": "string"
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/payment/coupons/{id}",
  "metodo": "PATCH",
  "ruta": "/api/payment/coupons/{id}",
  "dominio": "payment",
  "resumen": "Updates the Coupon resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentcoupons_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "innerName": {
      "type": "string"
     },
     "expirationDate": {
      "type": [
       "string",
       "null"
      ],
      "format": "date-time"
     },
     "limitOfUse": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/payment/digital-products/{id}",
  "metodo": "PATCH",
  "ruta": "/api/payment/digital-products/{id}",
  "dominio": "payment",
  "resumen": "Updates the DigitalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentdigital-products_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string"
     },
     "resources": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "type"
       ],
       "properties": {
        "type": {
         "type": "string",
         "enum": [
          "membership_course",
          "membership_course_bundle",
          "systemeio_tag",
          "community_access",
          "downloadable_file",
          "booking_event",
          "systemeio_plan",
          "systemeio_campaign_step"
         ]
        },
        "modules": {
         "type": "array",
         "items": {
          "type": "integer"
         }
        },
        "value": {
         "type": [
          "string",
          "null"
         ]
        },
        "courseId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "courseBundleId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "enrollmentAccessType": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          "full_access",
          "partial_access",
          "dripping_content",
          "partial_dripping_access"
         ]
        },
        "enrollmentDrippingAccessCourseId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "expirationPeriod": {
         "type": [
          "integer",
          "null"
         ]
        },
        "accessFrom": {
         "type": [
          "string",
          "null"
         ],
         "format": "date-time"
        },
        "dataFileId": {
         "type": [
          "integer",
          "null"
         ]
        }
       },
       "allOf": [
        {
         "oneOf": [
          {
           "required": [
            "type",
            "courseId",
            "enrollmentAccessType",
            "modules"
           ],
           "properties": {
            "type": {
             "enum": [
              "membership_course"
             ]
            },
            "courseId": {
             "type": "integer"
            },
            "enrollmentAccessType": {
             "enum": [
              "partial_access",
              "partial_dripping_access"
             ]
            },
            "modules": {
             "type": "array"
            }
           }
          },
          {
           "required": [
            "type",
            "courseId",
            "enrollmentAccessType"
           ],
           "properties": {
            "type": {
             "enum": [
              "membership_course"
             ]
            },
            "courseId": {
             "type": "integer"
            },
            "enrollmentAccessType": {
             "enum": [
              "full_access",
              "dripping_content"
             ]
            }
           }
          },
          {
           "required": [
            "type",
            "courseBundleId",
            "enrollmentAccessType"
           ],
           "properties": {
            "type": {
             "enum": [
              "membership_course_bundle"
             ]
            },
            "courseBundleId": {
             "type": "integer"
            },
            "enrollmentAccessType": {
             "enum": [
              "full_access",
              "partial_access",
              "dripping_content",
              "partial_dripping_access"
             ]
            }
           }
          },
          {
           "required": [
            "type",
            "value"
           ],
           "properties": {
            "type": {
             "enum": [
              "systemeio_tag"
             ]
            },
            "value": {
             "type": "string"
            }
           }
          },
          {
           "required": [
            "type",
            "value"
           ],
           "properties": {
            "type": {
             "enum": [
              "booking_event"
             ]
            },
            "value": {
             "type": "string"
            }
           }
          },
          {
           "required": [
            "type"
           ],
           "properties": {
            "type": {
             "enum": [
              "downloadable_file"
             ]
            }
           }
          },
          {
           "required": [
            "type"
           ],
           "properties": {
            "type": {
             "enum": [
              "community_access"
             ]
            }
           }
          }
         ]
        }
       ]
      }
     },
     "pricePlans": {
      "type": "array",
      "items": {
       "type": "integer"
      }
     },
     "confirmationEmailId": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/payment/offers/{id}",
  "metodo": "PATCH",
  "ruta": "/api/payment/offers/{id}",
  "dominio": "payment",
  "resumen": "Updates the Offer resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentoffers_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "affiliateCommission": {
      "type": "integer"
     },
     "payoutDelay": {
      "type": "integer"
     },
     "bumps": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "digitalProductId",
        "physicalProductId"
       ],
       "properties": {
        "digitalProductId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "physicalProductId": {
         "type": [
          "integer",
          "null"
         ]
        }
       }
      }
     },
     "digitalProductId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "physicalProductId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "coupons": {
      "type": "array",
      "items": {
       "type": "integer"
      }
     },
     "saleLimit": {
      "type": [
       "integer",
       "null"
      ]
     },
     "saleLimitFunnelStepRedirectId": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/payment/physical-products/{id}",
  "metodo": "PATCH",
  "ruta": "/api/payment/physical-products/{id}",
  "dominio": "payment",
  "resumen": "Updates the PhysicalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentphysical-products_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string"
     },
     "tax": {
      "type": "number"
     },
     "taxBehavior": {
      "type": "string",
      "enum": [
       "exclusive",
       "inclusive"
      ]
     },
     "sku": {
      "type": "string"
     },
     "currency": {
      "type": "string",
      "enum": [
       "aud",
       "cad",
       "dkk",
       "eur",
       "hkd",
       "ils",
       "jpy",
       "mxn",
       "nzd",
       "nok",
       "php",
       "pln",
       "gbp",
       "rub",
       "sgd",
       "sek",
       "chf",
       "thb",
       "usd",
       "brl",
       "inr",
       "myr",
       "czk",
       "ron",
       "aed",
       "huf",
       "cop",
       "xaf",
       "clp",
       "egp",
       "ghs",
       "gnf",
       "kes",
       "mwk",
       "mad",
       "ngn",
       "rwf",
       "sll",
       "std",
       "zar",
       "tzs",
       "ugx",
       "xof",
       "zmw",
       "bgn",
       "isk",
       "try",
       "ars",
       "sar",
       "idr",
       "lkr",
       "cny",
       "rsd",
       "uah",
       "all",
       "vnd",
       "pen",
       "twd"
      ]
     },
     "price": {
      "type": "integer"
     },
     "weight": {
      "type": "integer"
     },
     "description": {
      "type": [
       "string",
       "null"
      ]
     },
     "limitStock": {
      "type": "boolean"
     },
     "stock": {
      "type": [
       "integer",
       "null"
      ]
     },
     "shippingFeesDisabled": {
      "type": "boolean"
     },
     "images": {
      "type": "array",
      "items": {
       "type": "integer"
      }
     },
     "options": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "name",
        "optionValues"
       ],
       "properties": {
        "id": {
         "type": "string"
        },
        "name": {
         "type": "string"
        },
        "optionValues": {
         "type": "array",
         "items": {
          "type": "object",
          "required": [
           "value"
          ],
          "properties": {
           "id": {
            "type": "string"
           },
           "value": {
            "type": "string"
           }
          }
         }
        }
       }
      }
     },
     "productVariants": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "sku",
        "price",
        "imageId",
        "stock",
        "optionValueIds"
       ],
       "properties": {
        "id": {
         "type": "string"
        },
        "sku": {
         "type": "string"
        },
        "price": {
         "type": [
          "integer",
          "null"
         ]
        },
        "imageId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "stock": {
         "type": [
          "integer",
          "null"
         ]
        },
        "optionValueIds": {
         "type": "array",
         "items": {
          "type": "string"
         }
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/payment/price-plans/{id}",
  "metodo": "PATCH",
  "ruta": "/api/payment/price-plans/{id}",
  "dominio": "payment",
  "resumen": "Updates the PricePlan resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentprice-plans_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string"
     },
     "innerName": {
      "type": "string"
     },
     "statementDescriptor": {
      "type": "string"
     },
     "statementDescriptorKatakana": {
      "type": [
       "string",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/payment/sale-settings/{externalId}",
  "metodo": "PATCH",
  "ruta": "/api/payment/sale-settings/{externalId}",
  "dominio": "payment",
  "resumen": "Updates the SaleSettings resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentsale-settings_externalid_patch",
  "parametros": [
   {
    "nombre": "externalId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string",
     "format": "uuid"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "currency": {
      "type": "string",
      "enum": [
       "aud",
       "cad",
       "dkk",
       "eur",
       "hkd",
       "ils",
       "jpy",
       "mxn",
       "nzd",
       "nok",
       "php",
       "pln",
       "gbp",
       "rub",
       "sgd",
       "sek",
       "chf",
       "thb",
       "usd",
       "brl",
       "inr",
       "myr",
       "czk",
       "ron",
       "aed",
       "huf",
       "cop",
       "xaf",
       "clp",
       "egp",
       "ghs",
       "gnf",
       "kes",
       "mwk",
       "mad",
       "ngn",
       "rwf",
       "sll",
       "std",
       "zar",
       "tzs",
       "ugx",
       "xof",
       "zmw",
       "bgn",
       "isk",
       "try",
       "ars",
       "sar",
       "idr",
       "lkr",
       "cny",
       "rsd",
       "uah",
       "all",
       "vnd",
       "pen",
       "twd"
      ]
     },
     "paymentMethods": {
      "type": "array",
      "items": {
       "type": "string",
       "enum": [
        "stripe:card",
        "stripe:applepay",
        "stripe:ideal",
        "stripe:bancontact",
        "stripe:klarna",
        "stripe:multibanco",
        "dlocal:card",
        "dlocal:boleto",
        "dlocal:pix",
        "paypal-soap",
        "mercadopago-br:card",
        "mercadopago-br:pix",
        "mercadopago-br:boleto",
        "mercadopago-co:card",
        "mercadopago-mx:card",
        "mercadopago-ar:card",
        "mercadopago-cl:card",
        "razorpay",
        "flutterwave",
        "mollie",
        "gocardless",
        "xendit-id:card",
        "xendit-id:dd",
        "xendit-id:ewallet",
        "xendit-ph:card",
        "xendit-ph:dd",
        "xendit-ph:ewallet",
        "paystack-gh:card",
        "paystack-ke:card",
        "paystack-ng:card",
        "paystack-za:card",
        "paystack-eg:card",
        "paystack-ci:card",
        "cash-on-delivery",
        "paypal-rest",
        "secure-and-pay"
       ]
      }
     },
     "disableTax": {
      "type": "boolean"
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/school/course-modules/{moduleId}",
  "metodo": "PATCH",
  "ruta": "/api/school/course-modules/{moduleId}",
  "dominio": "school",
  "resumen": "Updates the Module resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourse-modules_moduleid_patch",
  "parametros": [
   {
    "nombre": "moduleId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string"
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/school/courses/{id}",
  "metodo": "PATCH",
  "ruta": "/api/school/courses/{id}",
  "dominio": "school",
  "resumen": "Updates the Course resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_id_patch",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "domainId": {
      "type": "integer"
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
     },
     "description": {
      "type": [
       "string",
       "null"
      ]
     },
     "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
     },
     "instructorName": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 255
     },
     "embeddedCode": {
      "type": [
       "string",
       "null"
      ]
     },
     "fontFamily": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
     },
     "headlineFontFamily": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
     },
     "salesFunnelStepId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "showModulesTitles": {
      "type": "boolean"
     },
     "issueCertificateUponCompletion": {
      "type": "boolean"
     },
     "locale": {
      "type": "string"
     },
     "themeId": {
      "type": "integer"
     },
     "imageDataFileId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "logoDataFileId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "teacherPhotoDataFileId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "signatureDataFileId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "certificateLogoDataFileId": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/school/lectures/{lectureId}",
  "metodo": "PATCH",
  "ruta": "/api/school/lectures/{lectureId}",
  "dominio": "school",
  "resumen": "Updates the Lecture resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoollectures_lectureid_patch",
  "parametros": [
   {
    "nombre": "lectureId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string"
     },
     "delayBeforePreviousLecture": {
      "type": "integer"
     },
     "showComments": {
      "type": "boolean"
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/sms/templates/{templateId}",
  "metodo": "PATCH",
  "ruta": "/api/sms/templates/{templateId}",
  "dominio": "sms",
  "resumen": "Updates the SmsTemplate resource.",
  "documentacion": "https://developer.systeme.io/reference/api_smstemplates_templateid_patch",
  "parametros": [
   {
    "nombre": "templateId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 450
     },
     "content": {
      "type": "string",
      "maxLength": 1600
     },
     "senderType": {
      "type": "string",
      "enum": [
       "PHONE_NUMBER",
       "ALPHANUMERIC",
       "MESSAGE_SERVICE"
      ]
     },
     "phoneNumber": {
      "type": [
       "string",
       "null"
      ]
     },
     "alphanumericSender": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 11
     },
     "messageServiceSid": {
      "type": [
       "string",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PATCH /api/webhooks/{id}",
  "metodo": "PATCH",
  "ruta": "/api/webhooks/{id}",
  "dominio": "webhooks",
  "resumen": "Updates the Webhook resource.",
  "documentacion": "https://developer.systeme.io/reference/api_webhooks_id_patch-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/merge-patch+json",
   "esquema": {
    "type": "object",
    "properties": {
     "name": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 255
     },
     "secret": {
      "type": [
       "string",
       "null"
      ]
     },
     "subscriptions": {
      "type": "array",
      "items": {
       "oneOf": [
        {
         "type": "string",
         "enum": [
          "CONTACT_CREATED",
          "CONTACT_TAG_ADDED",
          "CONTACT_TAG_REMOVED",
          "CONTACT_OPT_IN",
          "SALE_NEW",
          "SALE_CANCELED"
         ]
        },
        {
         "type": "object",
         "required": [
          "event",
          "schemaVersion"
         ],
         "properties": {
          "event": {
           "type": "string",
           "enum": [
            "CONTACT_CREATED",
            "CONTACT_TAG_ADDED",
            "CONTACT_TAG_REMOVED",
            "CONTACT_OPT_IN",
            "SALE_NEW",
            "SALE_CANCELED"
           ]
          },
          "schemaVersion": {
           "type": "integer"
          }
         }
        }
       ]
      }
     },
     "active": {
      "type": [
       "boolean",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/automation/rules",
  "metodo": "POST",
  "ruta": "/api/automation/rules",
  "dominio": "automation",
  "resumen": "Creates a AutomationRule resource.",
  "documentacion": "https://developer.systeme.io/reference/api_automationrules_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "properties": {
     "triggers": {
      "type": "array",
      "items": {
       "oneOf": [
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "tag_added"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "tag_removed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "form_subscribed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "booking_created"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "bookingEventId"
           ],
           "additionalProperties": false,
           "properties": {
            "bookingEventId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "campaign_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "campaignId"
           ],
           "additionalProperties": false,
           "properties": {
            "campaignId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "enrolled_in_course"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "course_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "module_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "moduleId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "lecture_completed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "moduleId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "lectureId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "new_sale"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "sale_canceled"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "subscription_payment_failed"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "page_visited"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "funnelStepId"
           ],
           "additionalProperties": false,
           "properties": {
            "funnelStepId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        }
       ]
      }
     },
     "actions": {
      "type": "array",
      "items": {
       "oneOf": [
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "add_tag"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "remove_tag"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "tagId"
           ],
           "additionalProperties": false,
           "properties": {
            "tagId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_email"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "automationEmailId"
           ],
           "additionalProperties": false,
           "properties": {
            "automationEmailId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_email_to_specific_address"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "automationEmailToSpecificAddressId"
           ],
           "additionalProperties": false,
           "properties": {
            "automationEmailToSpecificAddressId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "subscribe_to_campaign"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "campaignId"
           ],
           "additionalProperties": false,
           "properties": {
            "campaignId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "unsubscribe_from_campaign"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "campaignId"
           ],
           "additionalProperties": false,
           "properties": {
            "campaignId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_sms"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "smsTemplateId"
           ],
           "additionalProperties": false,
           "properties": {
            "smsTemplateId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "send_webhook"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "webhookUrl"
           ],
           "additionalProperties": false,
           "properties": {
            "webhookUrl": {
             "type": "string",
             "format": "uri"
            }
           }
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "enroll_in_course"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId",
            "courseAccessType"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            },
            "courseAccessType": {
             "type": "string",
             "enum": [
              "full_access",
              "partial_access",
              "dripping_content",
              "partial_dripping_access"
             ]
            },
            "courseModuleIds": {
             "type": [
              "array",
              "null"
             ],
             "items": {
              "type": "integer",
              "minimum": 1
             }
            }
           },
           "allOf": [
            {
             "oneOf": [
              {
               "required": [
                "courseAccessType",
                "courseModuleIds"
               ],
               "properties": {
                "courseAccessType": {
                 "enum": [
                  "partial_access",
                  "partial_dripping_access"
                 ]
                },
                "courseModuleIds": {
                 "type": "array"
                }
               }
              },
              {
               "required": [
                "courseAccessType"
               ],
               "properties": {
                "courseAccessType": {
                 "enum": [
                  "full_access",
                  "dripping_content"
                 ]
                },
                "courseModuleIds": {
                 "type": [
                  "array",
                  "null"
                 ]
                }
               }
              }
             ]
            }
           ]
          }
         }
        },
        {
         "type": "object",
         "required": [
          "type",
          "details"
         ],
         "additionalProperties": false,
         "properties": {
          "type": {
           "type": "string",
           "enum": [
            "revoke_access_to_course"
           ]
          },
          "details": {
           "type": "object",
           "required": [
            "courseId"
           ],
           "additionalProperties": false,
           "properties": {
            "courseId": {
             "type": [
              "integer",
              "null"
             ],
             "minimum": 1
            }
           }
          }
         }
        }
       ]
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/booking-calendar/events",
  "metodo": "POST",
  "ruta": "/api/booking-calendar/events",
  "dominio": "booking-calendar",
  "resumen": "Creates a CalendarEvent resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendarevents_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "eventDuration",
     "startTimeIncrement",
     "displayTimezoneType",
     "dateRangeMode",
     "hostName",
     "locations",
     "useGlobalAvailability"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 255
     },
     "eventDuration": {
      "type": "integer"
     },
     "description": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 5000
     },
     "googleCalendarId": {
      "type": [
       "string",
       "null"
      ]
     },
     "googleIntegrationId": {
      "type": [
       "string",
       "null"
      ]
     },
     "farOutBookRange": {
      "type": [
       "integer",
       "null"
      ],
      "minimum": 0,
      "maximum": 365
     },
     "nearestBookRange": {
      "type": [
       "integer",
       "null"
      ]
     },
     "cancellationDeadline": {
      "type": [
       "integer",
       "null"
      ],
      "maximum": 31536000
     },
     "maxParticipants": {
      "type": [
       "integer",
       "null"
      ]
     },
     "startTimeIncrement": {
      "type": "integer"
     },
     "bookingBufferTime": {
      "type": [
       "integer",
       "null"
      ]
     },
     "displayTimezoneType": {
      "type": "string",
      "enum": [
       "FIXED",
       "LOCAL"
      ]
     },
     "dateRangeMode": {
      "type": "string",
      "enum": [
       "FAR_OUT_BOOK_RANGE",
       "RANGE",
       "INDEFINITE"
      ]
     },
     "eventType": {
      "type": "string",
      "enum": [
       "GROUP",
       "INDIVIDUAL"
      ],
      "default": "INDIVIDUAL"
     },
     "displayTimezone": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 255
     },
     "hostName": {
      "type": "string",
      "maxLength": 255
     },
     "hostAvatarUrl": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 2000
     },
     "customLogo": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 2000
     },
     "startDate": {
      "type": [
       "string",
       "null"
      ]
     },
     "endDate": {
      "type": [
       "string",
       "null"
      ]
     },
     "locations": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "locationType"
       ],
       "properties": {
        "locationType": {
         "type": "string",
         "enum": [
          "PERSONAL",
          "ZOOM",
          "ONLINE_MEETING",
          "PHONE",
          "GOOGLE_MEET"
         ]
        },
        "description": {
         "type": [
          "string",
          "null"
         ],
         "maxLength": 500
        },
        "meetingLink": {
         "type": [
          "string",
          "null"
         ],
         "maxLength": 500,
         "format": "uri"
        },
        "phone": {
         "type": [
          "string",
          "null"
         ]
        },
        "address": {
         "type": [
          "string",
          "null"
         ],
         "maxLength": 255
        }
       }
      }
     },
     "maxBookingsPerDay": {
      "type": [
       "integer",
       "null"
      ]
     },
     "useGlobalAvailability": {
      "type": "boolean"
     },
     "localUserAvailability": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "weeklyDailySettings": {
          "type": [
           "array",
           "null"
          ],
          "items": {
           "type": "object",
           "required": [
            "startTime",
            "endTime"
           ],
           "properties": {
            "dayOfWeek": {
             "type": [
              "string",
              "null"
             ],
             "enum": [
              "MONDAY",
              "TUESDAY",
              "WEDNESDAY",
              "THURSDAY",
              "FRIDAY",
              "SATURDAY",
              "SUNDAY",
              null
             ]
            },
            "date": {
             "type": [
              "string",
              "null"
             ]
            },
            "startTime": {
             "type": "integer"
            },
            "endTime": {
             "type": "integer"
            }
           }
          }
         },
         "dateSpecificDailySettings": {
          "type": [
           "array",
           "null"
          ],
          "items": {
           "type": "object",
           "required": [
            "startTime",
            "endTime"
           ],
           "properties": {
            "dayOfWeek": {
             "type": [
              "string",
              "null"
             ],
             "enum": [
              "MONDAY",
              "TUESDAY",
              "WEDNESDAY",
              "THURSDAY",
              "FRIDAY",
              "SATURDAY",
              "SUNDAY",
              null
             ]
            },
            "date": {
             "type": [
              "string",
              "null"
             ]
            },
            "startTime": {
             "type": "integer"
            },
            "endTime": {
             "type": "integer"
            }
           }
          }
         }
        }
       },
       {
        "type": "null"
       }
      ]
     },
     "reminderSettings": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "seconds"
       ],
       "properties": {
        "id": {
         "type": [
          "integer",
          "null"
         ]
        },
        "seconds": {
         "type": "integer",
         "minimum": 600
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/booking-calendar/user-availability",
  "metodo": "POST",
  "ruta": "/api/booking-calendar/user-availability",
  "dominio": "booking-calendar",
  "resumen": "Creates a UserAvailability resource.",
  "documentacion": "https://developer.systeme.io/reference/api_booking-calendaruser-availability_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "properties": {
     "weeklyDailySettings": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "startTime",
        "endTime"
       ],
       "properties": {
        "dayOfWeek": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
          null
         ]
        },
        "date": {
         "type": [
          "string",
          "null"
         ]
        },
        "startTime": {
         "type": "integer"
        },
        "endTime": {
         "type": "integer"
        }
       }
      }
     },
     "dateSpecificDailySettings": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "startTime",
        "endTime"
       ],
       "properties": {
        "dayOfWeek": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
          null
         ]
        },
        "date": {
         "type": [
          "string",
          "null"
         ]
        },
        "startTime": {
         "type": "integer"
        },
        "endTime": {
         "type": "integer"
        }
       }
      }
     },
     "unavailabilityRanges": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "object",
       "required": [
        "startDate",
        "endDate"
       ],
       "properties": {
        "startDate": {
         "type": "string"
        },
        "endDate": {
         "type": "string"
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/community/communities/{communityId}/memberships",
  "metodo": "POST",
  "ruta": "/api/community/communities/{communityId}/memberships",
  "dominio": "community",
  "resumen": "Creates a Membership resource.",
  "documentacion": "https://developer.systeme.io/reference/api_communitycommunities_communityidmemberships_post-1",
  "parametros": [
   {
    "nombre": "communityId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "contactId"
    ],
    "properties": {
     "contactId": {
      "type": "integer"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/contact_fields",
  "metodo": "POST",
  "ruta": "/api/contact_fields",
  "dominio": "contact_fields",
  "resumen": "Creates a ContactField resource.",
  "documentacion": "https://developer.systeme.io/reference/api_contact_fields_post-1",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "fieldName",
     "slug"
    ],
    "properties": {
     "fieldName": {
      "type": "string",
      "maxLength": 255
     },
     "slug": {
      "type": "string"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/contacts",
  "metodo": "POST",
  "ruta": "/api/contacts",
  "dominio": "contacts",
  "resumen": "Creates a Contact resource.",
  "documentacion": "https://developer.systeme.io/reference/post_contact-1",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "properties": {
     "email": {
      "type": "string"
     },
     "locale": {
      "type": [
       "string",
       "null"
      ],
      "enum": [
       "en",
       "fr",
       "es",
       "it",
       "pt",
       "de",
       "nl",
       "ru",
       "jp",
       "tr",
       "ar",
       "zh",
       "sv",
       "ro",
       "cs",
       "hu",
       "sk",
       "dk",
       "id",
       "pl",
       "el",
       "sr",
       "hi",
       "no",
       "th",
       "sq",
       "sl",
       "ua"
      ]
     },
     "fields": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "slug": {
         "type": "string"
        },
        "value": {
         "type": [
          "string",
          "null"
         ]
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/contacts/{id}/tags",
  "metodo": "POST",
  "ruta": "/api/contacts/{id}/tags",
  "dominio": "contacts",
  "resumen": "Assigns a Tag to a Contact.",
  "documentacion": "https://developer.systeme.io/reference/post_contact_tag-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": false,
   "mime": "application/json",
   "esquema": {
    "required": [
     "tagId"
    ],
    "properties": {
     "tagId": {
      "type": "integer"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/funnels",
  "metodo": "POST",
  "ruta": "/api/funnels",
  "dominio": "funnels",
  "resumen": "Creates a Funnel resource.",
  "documentacion": "https://developer.systeme.io/reference/api_funnels_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name"
    ],
    "properties": {
     "name": {
      "type": "string"
     },
     "funnelType": {
      "type": "string",
      "enum": [
       "optin",
       "sales",
       "webinar"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/funnels/{funnelId}/steps",
  "metodo": "POST",
  "ruta": "/api/funnels/{funnelId}/steps",
  "dominio": "funnels",
  "resumen": "Creates a FunnelStep resource.",
  "documentacion": "https://developer.systeme.io/reference/api_funnels_funnelidsteps_post",
  "parametros": [
   {
    "nombre": "funnelId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "type"
    ],
    "properties": {
     "name": {
      "type": "string"
     },
     "type": {
      "type": "string",
      "enum": [
       "squeeze",
       "opt_in_thank_you_page",
       "link_in_bio",
       "info_page",
       "inline",
       "popup",
       "upsell",
       "downsell",
       "offer-form",
       "contact_us_page",
       "order_thank_you_page",
       "sales_page",
       "webinar_registration",
       "webinar_thank_you",
       "webinar_session"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/automation-emails",
  "metodo": "POST",
  "ruta": "/api/mailing/automation-emails",
  "dominio": "mailing",
  "resumen": "Creates a AutomationEmail resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "content"
    ],
    "properties": {
     "content": {
      "type": "object",
      "required": [
       "subject"
      ],
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ],
        "default": "classic"
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": [
         "object",
         "null"
        ]
       },
       "senderEmail": {
        "type": [
         "string",
         "null"
        ],
        "format": "email"
       },
       "senderName": {
        "type": [
         "string",
         "null"
        ]
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/automation-emails-to-specific-address",
  "metodo": "POST",
  "ruta": "/api/mailing/automation-emails-to-specific-address",
  "dominio": "mailing",
  "resumen": "Creates a AutomationEmailToSpecificAddress resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingautomation-emails-to-specific-address_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "recipientAddress",
     "content"
    ],
    "properties": {
     "recipientAddress": {
      "type": "string",
      "format": "email"
     },
     "content": {
      "type": "object",
      "required": [
       "subject"
      ],
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ],
        "default": "classic"
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": [
         "object",
         "null"
        ]
       },
       "senderEmail": {
        "type": [
         "string",
         "null"
        ],
        "format": "email"
       },
       "senderName": {
        "type": [
         "string",
         "null"
        ]
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/campaign-steps/{id}/send-test",
  "metodo": "POST",
  "ruta": "/api/mailing/campaign-steps/{id}/send-test",
  "dominio": "mailing",
  "resumen": "Creates a CampaignStep resource.",
  "documentacion": "https://developer.systeme.io/reference/campaign_step_send_test",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "properties": {
     "testRecipientEmail": {
      "type": [
       "string",
       "null"
      ],
      "format": "email"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/campaigns",
  "metodo": "POST",
  "ruta": "/api/mailing/campaigns",
  "dominio": "mailing",
  "resumen": "Creates a Campaign resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 255
     },
     "senderEmail": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 255,
      "format": "email"
     },
     "description": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 2000
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/campaigns/{campaignId}/steps",
  "metodo": "POST",
  "ruta": "/api/mailing/campaigns/{campaignId}/steps",
  "dominio": "mailing",
  "resumen": "Creates a CampaignStep resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingcampaigns_campaignidsteps_post",
  "parametros": [
   {
    "nombre": "campaignId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "content"
    ],
    "properties": {
     "comment": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 1000
     },
     "content": {
      "type": "object",
      "required": [
       "subject"
      ],
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ],
        "default": "classic"
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": "object",
        "nullable": true
       },
       "senderEmail": {
        "type": [
         "string",
         "null"
        ],
        "format": "email"
       },
       "senderName": {
        "type": [
         "string",
         "null"
        ]
       }
      }
     },
     "activation": {
      "anyOf": [
       {
        "type": "object",
        "required": [
         "afterStepId"
        ],
        "properties": {
         "afterStepId": {
          "type": [
           "integer",
           "null"
          ]
         },
         "delay": {
          "anyOf": [
           {
            "type": "object",
            "required": [
             "value",
             "unit"
            ],
            "properties": {
             "value": {
              "type": "integer"
             },
             "unit": {
              "type": "string",
              "enum": [
               "minute",
               "hour",
               "day"
              ]
             }
            }
           },
           {
            "type": "null"
           }
          ]
         },
         "sendAtLocalTime": {
          "type": [
           "string",
           "null"
          ]
         },
         "skipWeekdays": {
          "type": "array",
          "items": {
           "type": "string",
           "enum": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday"
           ]
          }
         }
        }
       },
       {
        "type": "null"
       }
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/newsletters",
  "metodo": "POST",
  "ruta": "/api/mailing/newsletters",
  "dominio": "mailing",
  "resumen": "Creates a Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/api_mailingnewsletters_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "content"
    ],
    "properties": {
     "content": {
      "type": "object",
      "required": [
       "subject"
      ],
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "editorType": {
        "type": "string",
        "enum": [
         "classic",
         "visual"
        ],
        "default": "classic"
       },
       "bodyHtml": {
        "type": [
         "string",
         "null"
        ]
       },
       "bodyJson": {
        "type": [
         "array",
         "null"
        ],
        "items": {
         "type": "string"
        }
       },
       "senderEmail": {
        "type": [
         "string",
         "null"
        ],
        "format": "email"
       },
       "senderName": {
        "type": [
         "string",
         "null"
        ]
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/mailing/newsletters/{id}/send",
  "metodo": "POST",
  "ruta": "/api/mailing/newsletters/{id}/send",
  "dominio": "mailing",
  "resumen": "Creates a Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_send",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "POST /api/mailing/newsletters/{id}/send-test",
  "metodo": "POST",
  "ruta": "/api/mailing/newsletters/{id}/send-test",
  "dominio": "mailing",
  "resumen": "Creates a Newsletter resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_send_test",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "properties": {
     "testRecipientEmail": {
      "type": [
       "string",
       "null"
      ],
      "format": "email"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/page-editor/page-schema",
  "metodo": "POST",
  "ruta": "/api/page-editor/page-schema",
  "dominio": "page-editor",
  "resumen": "Returns a Page JSON Schema.",
  "documentacion": "https://developer.systeme.io/reference/api_page-editorpage-schema_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "type"
    ],
    "properties": {
     "type": {
      "type": "string",
      "enum": [
       "squeeze",
       "opt_in_thank_you_page",
       "link_in_bio",
       "info_page",
       "inline",
       "popup",
       "sales_page",
       "upsell",
       "downsell",
       "offer-form",
       "contact_us_page",
       "order_thank_you_page",
       "webinar_registration",
       "webinar_thank_you",
       "webinar_session",
       "lecture"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/page-editor/page-template",
  "metodo": "POST",
  "ruta": "/api/page-editor/page-template",
  "dominio": "page-editor",
  "resumen": "[Beta] Returns a page template description.",
  "documentacion": "https://developer.systeme.io/reference/api_page-editorpage-template_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "type"
    ],
    "properties": {
     "type": {
      "type": "string",
      "enum": [
       "squeeze",
       "opt_in_thank_you_page",
       "link_in_bio",
       "info_page",
       "inline",
       "popup",
       "sales_page",
       "upsell",
       "downsell",
       "offer-form",
       "contact_us_page",
       "order_thank_you_page",
       "webinar_registration",
       "webinar_thank_you",
       "webinar_session",
       "lecture"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/payment/coupons",
  "metodo": "POST",
  "ruta": "/api/payment/coupons",
  "dominio": "payment",
  "resumen": "Creates a Coupon resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentcoupons_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "innerName",
     "code",
     "discountAmount",
     "discountType",
     "currency"
    ],
    "properties": {
     "innerName": {
      "type": "string"
     },
     "code": {
      "type": "string"
     },
     "discountAmount": {
      "type": "number"
     },
     "discountType": {
      "type": "string",
      "enum": [
       "fixed",
       "percent"
      ]
     },
     "expirationDate": {
      "type": [
       "string",
       "null"
      ],
      "format": "date-time"
     },
     "limitOfUse": {
      "type": [
       "integer",
       "null"
      ]
     },
     "currency": {
      "type": "string",
      "enum": [
       "aud",
       "cad",
       "dkk",
       "eur",
       "hkd",
       "ils",
       "jpy",
       "mxn",
       "nzd",
       "nok",
       "php",
       "pln",
       "gbp",
       "rub",
       "sgd",
       "sek",
       "chf",
       "thb",
       "usd",
       "brl",
       "inr",
       "myr",
       "czk",
       "ron",
       "aed",
       "huf",
       "cop",
       "xaf",
       "clp",
       "egp",
       "ghs",
       "gnf",
       "kes",
       "mwk",
       "mad",
       "ngn",
       "rwf",
       "sll",
       "std",
       "zar",
       "tzs",
       "ugx",
       "xof",
       "zmw",
       "bgn",
       "isk",
       "try",
       "ars",
       "sar",
       "idr",
       "lkr",
       "cny",
       "rsd",
       "uah",
       "all",
       "vnd",
       "pen",
       "twd"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/payment/digital-products",
  "metodo": "POST",
  "ruta": "/api/payment/digital-products",
  "dominio": "payment",
  "resumen": "Creates a DigitalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentdigital-products_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "source"
    ],
    "properties": {
     "name": {
      "type": "string"
     },
     "source": {
      "type": "string",
      "enum": [
       "digital-store",
       "funnel",
       "Whitelabel"
      ]
     },
     "resources": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "type"
       ],
       "properties": {
        "type": {
         "type": "string",
         "enum": [
          "membership_course",
          "membership_course_bundle",
          "systemeio_tag",
          "community_access",
          "downloadable_file",
          "booking_event",
          "systemeio_plan",
          "systemeio_campaign_step"
         ]
        },
        "modules": {
         "type": "array",
         "items": {
          "type": "integer"
         }
        },
        "value": {
         "type": [
          "string",
          "null"
         ]
        },
        "courseId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "courseBundleId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "enrollmentAccessType": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          "full_access",
          "partial_access",
          "dripping_content",
          "partial_dripping_access"
         ]
        },
        "enrollmentDrippingAccessCourseId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "expirationPeriod": {
         "type": [
          "integer",
          "null"
         ]
        },
        "accessFrom": {
         "type": [
          "string",
          "null"
         ],
         "format": "date-time"
        },
        "dataFileId": {
         "type": [
          "integer",
          "null"
         ]
        }
       },
       "allOf": [
        {
         "oneOf": [
          {
           "required": [
            "type",
            "courseId",
            "enrollmentAccessType",
            "modules"
           ],
           "properties": {
            "type": {
             "enum": [
              "membership_course"
             ]
            },
            "courseId": {
             "type": "integer"
            },
            "enrollmentAccessType": {
             "enum": [
              "partial_access",
              "partial_dripping_access"
             ]
            },
            "modules": {
             "type": "array"
            }
           }
          },
          {
           "required": [
            "type",
            "courseId",
            "enrollmentAccessType"
           ],
           "properties": {
            "type": {
             "enum": [
              "membership_course"
             ]
            },
            "courseId": {
             "type": "integer"
            },
            "enrollmentAccessType": {
             "enum": [
              "full_access",
              "dripping_content"
             ]
            }
           }
          },
          {
           "required": [
            "type",
            "courseBundleId",
            "enrollmentAccessType"
           ],
           "properties": {
            "type": {
             "enum": [
              "membership_course_bundle"
             ]
            },
            "courseBundleId": {
             "type": "integer"
            },
            "enrollmentAccessType": {
             "enum": [
              "full_access",
              "partial_access",
              "dripping_content",
              "partial_dripping_access"
             ]
            }
           }
          },
          {
           "required": [
            "type",
            "value"
           ],
           "properties": {
            "type": {
             "enum": [
              "systemeio_tag"
             ]
            },
            "value": {
             "type": "string"
            }
           }
          },
          {
           "required": [
            "type",
            "value"
           ],
           "properties": {
            "type": {
             "enum": [
              "booking_event"
             ]
            },
            "value": {
             "type": "string"
            }
           }
          },
          {
           "required": [
            "type"
           ],
           "properties": {
            "type": {
             "enum": [
              "downloadable_file"
             ]
            }
           }
          },
          {
           "required": [
            "type"
           ],
           "properties": {
            "type": {
             "enum": [
              "community_access"
             ]
            }
           }
          }
         ]
        }
       ]
      }
     },
     "pricePlans": {
      "type": "array",
      "items": {
       "type": "integer"
      }
     },
     "confirmationEmailId": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/payment/offers",
  "metodo": "POST",
  "ruta": "/api/payment/offers",
  "dominio": "payment",
  "resumen": "Creates a Offer resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentoffers_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "affiliateCommission",
     "payoutDelay",
     "bumps",
     "digitalProductId",
     "physicalProductId",
     "coupons",
     "saleLimit",
     "saleLimitFunnelStepRedirectId"
    ],
    "properties": {
     "affiliateCommission": {
      "type": "integer"
     },
     "payoutDelay": {
      "type": "integer"
     },
     "bumps": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "digitalProductId",
        "physicalProductId"
       ],
       "properties": {
        "digitalProductId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "physicalProductId": {
         "type": [
          "integer",
          "null"
         ]
        }
       }
      }
     },
     "digitalProductId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "physicalProductId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "coupons": {
      "type": "array",
      "items": {
       "type": "integer"
      }
     },
     "saleLimit": {
      "type": [
       "integer",
       "null"
      ]
     },
     "saleLimitFunnelStepRedirectId": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/payment/physical-products",
  "metodo": "POST",
  "ruta": "/api/payment/physical-products",
  "dominio": "payment",
  "resumen": "Creates a PhysicalProduct resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentphysical-products_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "tax",
     "sku",
     "currency",
     "price",
     "weight"
    ],
    "properties": {
     "name": {
      "type": "string"
     },
     "tax": {
      "type": "number"
     },
     "sku": {
      "type": "string"
     },
     "currency": {
      "type": "string",
      "enum": [
       "aud",
       "cad",
       "dkk",
       "eur",
       "hkd",
       "ils",
       "jpy",
       "mxn",
       "nzd",
       "nok",
       "php",
       "pln",
       "gbp",
       "rub",
       "sgd",
       "sek",
       "chf",
       "thb",
       "usd",
       "brl",
       "inr",
       "myr",
       "czk",
       "ron",
       "aed",
       "huf",
       "cop",
       "xaf",
       "clp",
       "egp",
       "ghs",
       "gnf",
       "kes",
       "mwk",
       "mad",
       "ngn",
       "rwf",
       "sll",
       "std",
       "zar",
       "tzs",
       "ugx",
       "xof",
       "zmw",
       "bgn",
       "isk",
       "try",
       "ars",
       "sar",
       "idr",
       "lkr",
       "cny",
       "rsd",
       "uah",
       "all",
       "vnd",
       "pen",
       "twd"
      ]
     },
     "price": {
      "type": "integer"
     },
     "weight": {
      "type": "integer"
     },
     "taxBehavior": {
      "type": "string",
      "enum": [
       "exclusive",
       "inclusive"
      ],
      "default": "exclusive"
     },
     "description": {
      "type": [
       "string",
       "null"
      ]
     },
     "limitStock": {
      "type": "boolean"
     },
     "stock": {
      "type": [
       "integer",
       "null"
      ]
     },
     "shippingFeesDisabled": {
      "type": "boolean"
     },
     "images": {
      "type": "array",
      "items": {
       "type": "integer"
      }
     },
     "options": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "name"
       ],
       "properties": {
        "name": {
         "type": "string"
        },
        "optionValues": {
         "type": "array",
         "items": {
          "type": "object",
          "required": [
           "value"
          ],
          "properties": {
           "value": {
            "type": "string"
           }
          }
         }
        }
       }
      }
     },
     "productVariants": {
      "type": "array",
      "items": {
       "type": "object",
       "required": [
        "sku"
       ],
       "properties": {
        "sku": {
         "type": "string"
        },
        "price": {
         "type": [
          "integer",
          "null"
         ]
        },
        "imageId": {
         "type": [
          "integer",
          "null"
         ]
        },
        "stock": {
         "type": [
          "integer",
          "null"
         ]
        }
       }
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/payment/price-plans",
  "metodo": "POST",
  "ruta": "/api/payment/price-plans",
  "dominio": "payment",
  "resumen": "Creates a PricePlan resource.",
  "documentacion": "https://developer.systeme.io/reference/api_paymentprice-plans_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "innerName",
     "statementDescriptor",
     "type",
     "amount",
     "currency"
    ],
    "properties": {
     "name": {
      "type": "string"
     },
     "innerName": {
      "type": "string"
     },
     "statementDescriptor": {
      "type": "string"
     },
     "statementDescriptorKatakana": {
      "type": [
       "string",
       "null"
      ]
     },
     "type": {
      "type": "string",
      "enum": [
       "one_shot",
       "subscription",
       "limited_subscription"
      ]
     },
     "amount": {
      "type": "integer",
      "maximum": 2147483647
     },
     "currency": {
      "type": "string",
      "enum": [
       "aud",
       "cad",
       "dkk",
       "eur",
       "hkd",
       "ils",
       "jpy",
       "mxn",
       "nzd",
       "nok",
       "php",
       "pln",
       "gbp",
       "rub",
       "sgd",
       "sek",
       "chf",
       "thb",
       "usd",
       "brl",
       "inr",
       "myr",
       "czk",
       "ron",
       "aed",
       "huf",
       "cop",
       "xaf",
       "clp",
       "egp",
       "ghs",
       "gnf",
       "kes",
       "mwk",
       "mad",
       "ngn",
       "rwf",
       "sll",
       "std",
       "zar",
       "tzs",
       "ugx",
       "xof",
       "zmw",
       "bgn",
       "isk",
       "try",
       "ars",
       "sar",
       "idr",
       "lkr",
       "cny",
       "rsd",
       "uah",
       "all",
       "vnd",
       "pen",
       "twd"
      ]
     },
     "recurringOptions": {
      "anyOf": [
       {
        "type": "object",
        "required": [
         "interval"
        ],
        "properties": {
         "trialPeriod": {
          "type": "integer"
         },
         "trialInterval": {
          "type": "string",
          "enum": [
           "day",
           "week",
           "month",
           "year"
          ],
          "default": "day"
         },
         "interval": {
          "type": "string",
          "enum": [
           "day",
           "week",
           "month",
           "year"
          ]
         },
         "intervalCount": {
          "type": "integer",
          "default": 1
         },
         "limitOfPayments": {
          "type": [
           "integer",
           "null"
          ]
         }
        }
       },
       {
        "type": "null"
       }
      ]
     },
     "category": {
      "type": "string",
      "enum": [
       "digital",
       "physical",
       "whitelabel"
      ],
      "default": "digital"
     },
     "taxBehavior": {
      "type": "string",
      "enum": [
       "exclusive",
       "inclusive"
      ],
      "default": "exclusive"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/payment/subscriptions/{id}/cancel",
  "metodo": "POST",
  "ruta": "/api/payment/subscriptions/{id}/cancel",
  "dominio": "payment",
  "resumen": "Unsubscribe.",
  "documentacion": "https://developer.systeme.io/reference/cancel_subscription-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": false,
   "mime": "application/json",
   "esquema": {
    "required": [
     "cancel"
    ],
    "properties": {
     "cancel": {
      "type": "string",
      "enum": [
       "Now",
       "WhenBillingPeriodEnds"
      ]
     }
    }
   }
  }
 },
 {
  "id": "POST /api/school/courses/{courseId}/enrollments",
  "metodo": "POST",
  "ruta": "/api/school/courses/{courseId}/enrollments",
  "dominio": "school",
  "resumen": "Creates an Enrollment resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_courseidenrollments_post-1",
  "parametros": [
   {
    "nombre": "courseId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "contactId",
     "accessType"
    ],
    "properties": {
     "contactId": {
      "type": [
       "integer",
       "null"
      ]
     },
     "accessType": {
      "type": [
       "string",
       "null"
      ],
      "enum": [
       "partial_access",
       "full_access",
       "dripping_content",
       "partial_dripping_access"
      ]
     },
     "modules": {
      "type": [
       "array",
       "null"
      ],
      "items": {
       "type": "integer"
      }
     }
    }
   }
  }
 },
 {
  "id": "POST /api/school/courses/{courseId}/modules",
  "metodo": "POST",
  "ruta": "/api/school/courses/{courseId}/modules",
  "dominio": "school",
  "resumen": "Creates a Module resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcourses_courseidmodules_post",
  "parametros": [
   {
    "nombre": "courseId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 255
     }
    }
   }
  }
 },
 {
  "id": "POST /api/school/courses/{id}/activate",
  "metodo": "POST",
  "ruta": "/api/school/courses/{id}/activate",
  "dominio": "school",
  "resumen": "Creates a Course resource.",
  "documentacion": "https://developer.systeme.io/reference/course_activate",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "POST /api/school/courses/{id}/deactivate",
  "metodo": "POST",
  "ruta": "/api/school/courses/{id}/deactivate",
  "dominio": "school",
  "resumen": "Creates a Course resource.",
  "documentacion": "https://developer.systeme.io/reference/course_deactivate",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "POST /api/school/courses/classic",
  "metodo": "POST",
  "ruta": "/api/school/courses/classic",
  "dominio": "school",
  "resumen": "Creates a Course resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolcoursesclassic_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "domainId",
     "name",
     "path",
     "themeId"
    ],
    "properties": {
     "domainId": {
      "type": "integer"
     },
     "name": {
      "type": "string",
      "maxLength": 255
     },
     "path": {
      "type": "string",
      "maxLength": 32
     },
     "themeId": {
      "type": "integer"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/school/lectures/{lectureId}/activate",
  "metodo": "POST",
  "ruta": "/api/school/lectures/{lectureId}/activate",
  "dominio": "school",
  "resumen": "Creates a Lecture resource.",
  "documentacion": "https://developer.systeme.io/reference/lecture_activate",
  "parametros": [
   {
    "nombre": "lectureId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "POST /api/school/lectures/{lectureId}/deactivate",
  "metodo": "POST",
  "ruta": "/api/school/lectures/{lectureId}/deactivate",
  "dominio": "school",
  "resumen": "Creates a Lecture resource.",
  "documentacion": "https://developer.systeme.io/reference/lecture_deactivate",
  "parametros": [
   {
    "nombre": "lectureId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ]
 },
 {
  "id": "POST /api/school/modules/{moduleId}/classic-lectures",
  "metodo": "POST",
  "ruta": "/api/school/modules/{moduleId}/classic-lectures",
  "dominio": "school",
  "resumen": "Creates a Lecture resource.",
  "documentacion": "https://developer.systeme.io/reference/api_schoolmodules_moduleidclassic-lectures_post",
  "parametros": [
   {
    "nombre": "moduleId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "delayBeforePreviousLecture"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 255
     },
     "delayBeforePreviousLecture": {
      "type": "integer",
      "minimum": 0,
      "maximum": 365
     },
     "showComments": {
      "type": "boolean"
     },
     "active": {
      "type": "boolean"
     }
    }
   }
  }
 },
 {
  "id": "POST /api/sms/templates",
  "metodo": "POST",
  "ruta": "/api/sms/templates",
  "dominio": "sms",
  "resumen": "Creates a SmsTemplate resource.",
  "documentacion": "https://developer.systeme.io/reference/api_smstemplates_post",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "content"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 450
     },
     "content": {
      "type": "string",
      "maxLength": 1600
     },
     "senderType": {
      "type": "string",
      "enum": [
       "PHONE_NUMBER",
       "ALPHANUMERIC",
       "MESSAGE_SERVICE"
      ],
      "default": "PHONE_NUMBER"
     },
     "phoneNumber": {
      "type": [
       "string",
       "null"
      ]
     },
     "alphanumericSender": {
      "type": [
       "string",
       "null"
      ],
      "maxLength": 11
     },
     "messageServiceSid": {
      "type": [
       "string",
       "null"
      ]
     }
    },
    "allOf": [
     {
      "oneOf": [
       {
        "required": [
         "phoneNumber"
        ],
        "properties": {
         "senderType": {
          "enum": [
           "PHONE_NUMBER"
          ]
         },
         "phoneNumber": {
          "type": "string",
          "minLength": 1
         }
        }
       },
       {
        "required": [
         "senderType",
         "alphanumericSender"
        ],
        "properties": {
         "senderType": {
          "enum": [
           "ALPHANUMERIC"
          ]
         },
         "alphanumericSender": {
          "type": "string",
          "minLength": 1
         }
        }
       },
       {
        "required": [
         "senderType",
         "messageServiceSid"
        ],
        "properties": {
         "senderType": {
          "enum": [
           "MESSAGE_SERVICE"
          ]
         },
         "messageServiceSid": {
          "type": "string",
          "minLength": 1
         }
        }
       }
      ]
     }
    ]
   }
  }
 },
 {
  "id": "POST /api/tags",
  "metodo": "POST",
  "ruta": "/api/tags",
  "dominio": "tags",
  "resumen": "Creates a Tag resource.",
  "documentacion": "https://developer.systeme.io/reference/api_tags_post-1",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 64
     }
    }
   }
  }
 },
 {
  "id": "POST /api/webhooks",
  "metodo": "POST",
  "ruta": "/api/webhooks",
  "dominio": "webhooks",
  "resumen": "Creates a Webhook resource.",
  "documentacion": "https://developer.systeme.io/reference/api_webhooks_post-1",
  "parametros": [],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name",
     "secret",
     "url",
     "subscriptions"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 255
     },
     "secret": {
      "type": "string"
     },
     "url": {
      "type": "string",
      "format": "uri"
     },
     "subscriptions": {
      "type": "array",
      "items": {
       "oneOf": [
        {
         "type": "string",
         "enum": [
          "CONTACT_CREATED",
          "CONTACT_TAG_ADDED",
          "CONTACT_TAG_REMOVED",
          "CONTACT_OPT_IN",
          "SALE_NEW",
          "SALE_CANCELED"
         ]
        },
        {
         "type": "object",
         "required": [
          "event",
          "schemaVersion"
         ],
         "properties": {
          "event": {
           "type": "string",
           "enum": [
            "CONTACT_CREATED",
            "CONTACT_TAG_ADDED",
            "CONTACT_TAG_REMOVED",
            "CONTACT_OPT_IN",
            "SALE_NEW",
            "SALE_CANCELED"
           ]
          },
          "schemaVersion": {
           "type": "integer"
          }
         }
        }
       ]
      }
     },
     "active": {
      "type": [
       "boolean",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PUT /api/mailing/newsletters/{id}",
  "metodo": "PUT",
  "ruta": "/api/mailing/newsletters/{id}",
  "dominio": "mailing",
  "resumen": "This endpoint is deprecated. Use PATCH instead",
  "documentacion": "https://developer.systeme.io/reference/api_mailingnewsletters_id_put",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "content"
    ],
    "properties": {
     "content": {
      "type": "object",
      "required": [
       "subject",
       "bodyHtml"
      ],
      "properties": {
       "subject": {
        "type": "string",
        "maxLength": 255
       },
       "previewText": {
        "type": [
         "string",
         "null"
        ],
        "maxLength": 140
       },
       "bodyHtml": {
        "type": "string"
       }
      }
     }
    }
   }
  },
  "obsoleta": true
 },
 {
  "id": "PUT /api/mailing/newsletters/{id}/excluded-tags",
  "metodo": "PUT",
  "ruta": "/api/mailing/newsletters/{id}/excluded-tags",
  "dominio": "mailing",
  "resumen": "Replaces the MailingTag resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_excluded_tags_put",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "tagIds"
    ],
    "properties": {
     "tagIds": {
      "type": "array",
      "items": {
       "type": "integer",
       "minimum": 1
      }
     }
    }
   }
  }
 },
 {
  "id": "PUT /api/mailing/newsletters/{id}/included-tags",
  "metodo": "PUT",
  "ruta": "/api/mailing/newsletters/{id}/included-tags",
  "dominio": "mailing",
  "resumen": "Replaces the MailingTag resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_included_tags_put",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "tagIds"
    ],
    "properties": {
     "tagIds": {
      "type": "array",
      "items": {
       "type": "integer",
       "minimum": 1
      }
     }
    }
   }
  }
 },
 {
  "id": "PUT /api/mailing/newsletters/{id}/schedule",
  "metodo": "PUT",
  "ruta": "/api/mailing/newsletters/{id}/schedule",
  "dominio": "mailing",
  "resumen": "Replaces the NewsletterSchedule resource.",
  "documentacion": "https://developer.systeme.io/reference/newsletter_schedule_put",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "scheduledAt"
    ],
    "properties": {
     "scheduledAt": {
      "type": [
       "string",
       "null"
      ],
      "format": "date-time"
     }
    }
   }
  }
 },
 {
  "id": "PUT /api/page-editor/pages/{id}/save",
  "metodo": "PUT",
  "ruta": "/api/page-editor/pages/{id}/save",
  "dominio": "page-editor",
  "resumen": "Replaces the PageContentSave resource.",
  "documentacion": "https://developer.systeme.io/reference/api_page-editorpages_idsave_put",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "aiContentSchema"
    ],
    "properties": {
     "aiContentSchema": {
      "type": [
       "object",
       "null"
      ]
     }
    }
   }
  }
 },
 {
  "id": "PUT /api/pages/{pageId}/content/from-template",
  "metodo": "PUT",
  "ruta": "/api/pages/{pageId}/content/from-template",
  "dominio": "pages",
  "resumen": "[Beta] Replaces page content from a template.",
  "documentacion": "https://developer.systeme.io/reference/api_pages_pageidcontentfrom-template_put",
  "parametros": [
   {
    "nombre": "pageId",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "integer",
     "minimum": 1
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "templateId",
     "placeholders"
    ],
    "properties": {
     "templateId": {
      "type": "string"
     },
     "placeholders": {
      "type": "object"
     }
    }
   }
  }
 },
 {
  "id": "PUT /api/payment/coupons/{id}",
  "metodo": "PUT",
  "ruta": "/api/payment/coupons/{id}",
  "dominio": "payment",
  "resumen": "This endpoint is deprecated. Use PATCH instead",
  "documentacion": "https://developer.systeme.io/reference/api_paymentcoupons_id_put",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "innerName"
    ],
    "properties": {
     "innerName": {
      "type": "string"
     },
     "expirationDate": {
      "type": [
       "string",
       "null"
      ],
      "format": "date-time"
     },
     "limitOfUse": {
      "type": [
       "integer",
       "null"
      ]
     }
    }
   }
  },
  "obsoleta": true
 },
 {
  "id": "PUT /api/tags/{id}",
  "metodo": "PUT",
  "ruta": "/api/tags/{id}",
  "dominio": "tags",
  "resumen": "Replaces the Tag resource.",
  "documentacion": "https://developer.systeme.io/reference/api_tags_id_put-1",
  "parametros": [
   {
    "nombre": "id",
    "en": "path",
    "requerido": true,
    "esquema": {
     "type": "string"
    }
   }
  ],
  "cuerpo": {
   "requerido": true,
   "mime": "application/json",
   "esquema": {
    "type": "object",
    "required": [
     "name"
    ],
    "properties": {
     "name": {
      "type": "string",
      "maxLength": 64
     }
    }
   }
  }
 }
] as const;
