// Every notification the app can raise, in one place: the event key, how it
// reads on screen and the priority it gets unless the business unit says
// otherwise (business_units.notification_priorities — edited on Admin → Unit
// settings). Adding an event here is all a new notification needs; the
// frontend reads the same list from GET /notifications/events.

export const PRIORITIES = ["high", "medium", "low"];
export const DEFAULT_PRIORITY = "medium";

export const NOTIFICATION_EVENTS = {
    "assignment.salesperson": { label: "Salesperson assigned", priority: "high" },
    "assignment.estimator": { label: "Estimator assigned", priority: "high" },
    "assignment.coordinator": { label: "Operations coordinator assigned", priority: "high" },
    "stage.advanced": { label: "Record moved to the next stage", priority: "medium" },
    "lifecycle.changed": { label: "Record marked won, lost or closed", priority: "medium" },
    "sla.overdue": { label: "SLA overdue", priority: "high" },
    "lead.captured": { label: "New lead captured", priority: "medium" },
    "estimation.on_hold": { label: "Estimation sent back to sales", priority: "high" },
    "estimation.site_visit": { label: "Pre-site inspection needed", priority: "medium" },
    "lead.changed": { label: "Lead details changed after handover", priority: "high" },
    "estimation.inputs.accepted": { label: "Estimation accepted the lead inputs", priority: "medium" },

    // Cross-department requests and assignments (modules/collaboration).
    "request.created": { label: "Request or assignment for you", priority: "high" },
    "request.response.submitted": { label: "Response to your request", priority: "high" },
    "request.clarification.requested": { label: "Clarification needed on your response", priority: "high" },
    "request.response.accepted": { label: "Your response was accepted", priority: "low" },
    "request.cancelled": { label: "Request cancelled", priority: "low" },
    "request.overdue": { label: "Request past its due date", priority: "high" },
    "assignment.schedule.changed": { label: "Assignment scheduled or moved", priority: "medium" },
    "assignment.progressed": { label: "Assignment progressed", priority: "low" },
    "assignment.completed": { label: "Assignment completed", priority: "medium" },
    "assignment.report.submitted": { label: "Assignment report submitted", priority: "high" },
};

export const EVENT_KEYS = Object.keys(NOTIFICATION_EVENTS);

export const isEventKey = (value) => Object.hasOwn(NOTIFICATION_EVENTS, String(value));

export const isPriority = (value) => PRIORITIES.includes(String(value));

/** The event catalogue as the settings screen and the inbox filter need it. */
export const eventCatalogue = () =>
    EVENT_KEYS.map((key) => ({ key, label: NOTIFICATION_EVENTS[key].label, defaultPriority: NOTIFICATION_EVENTS[key].priority }));
