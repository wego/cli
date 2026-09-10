/**
 * GENERATED FILE — do not edit.
 *
 * Source: apps/api/contract/openapi.json
 * Regenerate: bun run --filter cli api-types:generate
 *
 * The API's published response and request shapes, as TypeScript. `api-contract.ts`
 * compares them against the CLI's own Zod-inferred types; this file is never
 * imported at runtime.
 */

export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health check
         * @description Liveness probe.
         */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/user": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the authenticated user
         * @description Returns the caller's own identity, read from the verified access-token claims. Profile fields (email, name, country) appear only when the token carries them.
         */
        get: operations["getCurrentUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/feedback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit feedback
         * @description Records feedback about the Wego CLI/API experience – a rating (1-5), a category, and/or a free-text message. At least one of rating or message is required. Fire-and-forget: returns 202 and never blocks on recording.
         */
        post: operations["submitFeedback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/places/nearby": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Airports and cities near a point
         * @description The airports (and optionally cities) closest to a place or a coordinate pair, nearest first – for finding an alternative departure airport serving the same trip. Pass either place (a code, resolved to coordinates here) or latitude+longitude, never neither.
         */
        get: operations["getNearbyPlaces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/places": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Resolve travel locations
         * @description Resolves a free-text location query to canonical Wego places (cities, airports, states, districts, hotels) with codes and coordinates, for use in later flight and hotel searches. When metadata.hasAmbiguity is true, clarify with the user before proceeding.
         */
        get: operations["getPlaces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/countries/{countryCode}/holidays": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Public holidays for a market
         * @description Public holidays in one Wego market over a date range, for spotting long weekends before searching flights. Give both fromDate and toDate, or neither – omit both and the API searches the next 90 days and says so in metadata.window/from/to.
         */
        get: operations["getCountryHolidays"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/countries/{countryCode}/visa-free-destinations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Visa-free destinations for a passport
         * @description Where a passport can travel without a visa, as one complete list (the API walks the upstream's pages). An inspiration list, not a visa rule: it carries no visa type and no permitted stay, and a country's absence means absent from Wego's list, never that a visa is required.
         */
        get: operations["getVisaFreeDestinations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/searches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a flight search
         * @description Creates a metasearch for the given route/dates/passengers and returns its searchId. Results accrue asynchronously – poll getFlightSearchResults with the returned searchId to read ranked trips.
         */
        post: operations["createFlightSearch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/schedules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Published timetable for a route
         * @description What actually flies a route – times, duration, aircraft, and the weekdays each flight runs – with no prices and no search to settle. Nonstop flights only. Airport codes resolve to their parent city (LHR to LON), and metadata echoes what each side resolved to.
         */
        get: operations["getFlightSchedules"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/searches/{searchId}/results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read ranked flight results
         * @description Ranked trips as lean list cards (default 10, max 50 per page; out-of-range rejected 400), filters + sort applied. No completion flag: re-read (300ms→3s) until snapshotFareCount holds steady across two reads AND snapshotTripCount > 0. No fares[] on a card – read the trip for fares.
         */
        get: operations["getFlightSearchResults"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/trips/{tripId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Open one flight trip
         * @description Returns one trip's full itinerary and every fare on it (each kind-tagged), for the given tripId within its searchId. searchId is required – it comes from the search/results snapshot the tripId was read from.
         */
        get: operations["getFlightTrip"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/trips/{tripId}/experience": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a trip's experience signals
         * @description Per-leg signals for what a journey is like to sit through: overnight, longStopover, earlyDeparture, lateArrival, plus positive-only witnesses for a tight connection, aircraft age and carrier rating. No score - Recommended sort ranks on the price-adjusted fare score, which one would not match.
         */
        get: operations["getTripExperience"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/fares/{fareId}/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a fare's options
         * @description Returns a Book-on-Wego fare's bookable options (price, baggage, refundability, penalties, and the carrier's terms links when it publishes any), ordered by leg then price. A multi-leg trip needs ONE option per leg - read the top-level price, never min(options). Non-wego fareId 400; stale 404.
         */
        get: operations["getFareOptions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/fares/{fareId}/booking-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Build a fare's wego.com booking link
         * @description Builds the wego.com booking deep-link for a chosen Book-on-Wego fare, with one fare option pre-selected PER LEG. A pure, stateless URL build from the caller-supplied search context - no upstream call, no booking, no payment. The caller passes back the trip/leg/passenger context.
         */
        get: operations["getFareBookingLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/flights/search-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Build a durable wego.com search link
         * @description Builds a shareable wego.com flight-search URL from the caller's own route, dates, cabin and passengers. A pure, stateless string build - no upstream call, no search created. It carries no search-scoped id, so it does not expire: whoever opens it runs the search live.
         */
        get: operations["getFlightSearchLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/searches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a hotel search
         * @description Creates a Book-on-Wego hotel search (city, single hotel, or geo point) and returns its opaque searchId plus the occupancy priced upstream (resolved child ages, incl. the age-8 fallback when none supplied). Poll /results for ranked hotels. A hotelId search is the only one getHotelRates accepts.
         */
        post: operations["createHotelSearch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/searches/{searchId}/results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read hotel search results
         * @description Lean list cards; default 10, max 50 per page. searchComplete:true terminal, false advisory; poll snapshotCandidateCount to a steady non-zero. totalCandidates===0 = filters only if totalBeforeFilters>0, else none bookable once complete. ?refundable=true = witnessed.
         */
        get: operations["getHotelSearchResults"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/{hotelId}/rates/{rateId}/booking-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Build a hotel booking link
         * @description Returns the wego.com checkout URL for a chosen rate. Pure build: no upstream call, no booking, no payment – only 400/401/429.
         */
        get: operations["getHotelRateBookingLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/search-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Build a durable wego.com hotel search link
         * @description Builds a shareable wego.com hotel-search URL from the caller's own city, dates and occupancy. A pure, stateless string build: no search created. It carries no search-scoped id, so it does not expire: whoever opens it runs the search live.
         */
        get: operations["getHotelSearchLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/{hotelId}/rates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a hotel's rooms & rates
         * @description Returns the Book-on-Wego rooms & rates for a hotel (cheapest-first): room name, board, refundability, price, and each rate's composed booking reference id. searchId must name a hotel-scoped search (one created with hotelId); a city or geo search is a 409.
         */
        get: operations["getHotelRates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/{hotelId}/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search a hotel's guest reviews
         * @description Guest reviews for a hotel, newest first: rating, pros, cons and the provider. Filter by topic with ?topics=breakfast,pool and by cohort with ?guest-type=. Quote a review against metadata.totalCandidates, and cite metadata.matchedTerms for the word actually matched.
         */
        get: operations["getHotelReviews"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hotels/{hotelId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get hotel detail
         * @description Returns static hotel detail (name, stars, address, images, amenities, reviews). Use ?view=detail for the richer UI projection.
         */
        get: operations["getHotel"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description RFC 9457 Problem Details, served as application/problem+json. */
        Problem: {
            /**
             * Format: uri
             * @description Problem-type URI. `about:blank` for now (no semantics beyond the status); real type URIs follow once the public host is fixed.
             */
            type: string;
            /** @description Fixed human summary, the same across a `code`. */
            title: string;
            /** @description The HTTP status code, repeated as a JSON number. */
            status: number;
            /** @description Instance-specific human explanation of this failure. */
            detail?: string;
            /** @description The request path this occurrence happened on. */
            instance: string;
            /**
             * @description Stable machine token from a closed enum – the field an agent branches on.
             * @enum {string}
             */
            code: "validation_failed" | "invalid_token" | "insufficient_scope" | "not_found" | "rates_require_hotel_search" | "rate_limited" | "bad_gateway" | "upstream_unavailable" | "upstream_rate_limited" | "internal_error";
            /** @description Correlates this response to its logs; also returned in the `x-trace-id` response header. */
            trace_id: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The API is up. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /**
                         * @description Always "healthy" when the service is answering.
                         * @constant
                         */
                        status: "healthy";
                        /** @description Git commit SHA of the running build; absent when the platform supplied none. */
                        commit?: string;
                    };
                };
            };
        };
    };
    getCurrentUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller's identity claims. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The token subject (the JWT `sub`): the user's email, which auth.wego.com uses as the stable user identifier. */
                        sub: string;
                        /** @description Space-separated OAuth scopes granted to the token. */
                        scope?: string;
                        /** @description The user's email address, when the token carries it. */
                        email?: string;
                        /** @description The user's full display name, when present. */
                        name?: string;
                        /** @description The user's given name, when present. */
                        first_name?: string;
                        /** @description The user's family name, when present. */
                        last_name?: string;
                        /** @description The user's market country code, when present (id_token-sourced; usually absent on the access token). */
                        country_code?: string;
                        /** @description The AS's own numeric user id. Published as `string | number` because that is what it is: it arrives as a number today, and a `string`-only declaration would be a promise the API does not keep. */
                        uid?: string | number;
                        /** @description The auth server's principal name for the user, when present. */
                        principal_name?: string;
                    };
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    submitFeedback: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Overall rating, 1 (poor) to 5 (great).
                     * @example 5
                     */
                    rating?: number;
                    /**
                     * @description Which area the feedback is about.
                     * @enum {string}
                     */
                    category?: "flights" | "hotels" | "other";
                    /**
                     * @description Free-text feedback (bugs, ideas, what worked).
                     * @example Fare options were exactly what I needed.
                     */
                    message?: string;
                    /** @description CLI version the feedback came from. */
                    version?: string;
                };
            };
        };
        responses: {
            /** @description Feedback accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /**
                         * @description The feedback was accepted.
                         * @constant
                         */
                        status: "received";
                    };
                };
            };
            /** @description Invalid feedback body (e.g. neither rating nor message provided). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getNearbyPlaces: {
        parameters: {
            query?: {
                /** @description Place code to search around (e.g. LON, LHR). Resolved to coordinates before the upstream call. */
                place?: string;
                /** @description Latitude of the point to search around, decimal degrees (-90 to 90). Give latitude and longitude together; use either this pair or place, never both. */
                latitude?: number;
                /** @description Longitude of the point to search around, decimal degrees (-180 to 180). Give latitude and longitude together; use either this pair or place, never both. */
                longitude?: number;
                /** @description Place types to resolve; repeat or comma-separate to mix. */
                types?: ("city" | "airport" | "state" | "district" | "hotel")[];
                /** @description Language tag for localized place names (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Max results (1-50). Defaults to 50, the maximum, because this read wants the complete set of nearby places, not a page of it. The upstream returns roughly ten rows and ignores paging, so pageSize can only narrow that set, never reach further. */
                pageSize?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Nearby places, nearest first, plus the origin they were measured from. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The nearby places found around the origin. */
                        results: {
                            /** @description Opaque identifier, unique per place. Do not send it to other endpoints or build wego.com URLs from it: reference a place by code, or by cityCode for a hotels search. */
                            id?: number | string;
                            /** @description IATA-style code (airport/city), when the place has one. */
                            code?: string;
                            /** @description Display name of the place. */
                            name: string;
                            /** @description Place kind: city, airport, state, district or hotel. */
                            type: string;
                            /** @description Code of the city this place belongs to. */
                            cityCode?: string;
                            /** @description Latitude in decimal degrees, when known. */
                            latitude?: number;
                            /** @description Longitude in decimal degrees, when known. */
                            longitude?: number;
                        }[];
                        /** @description Pagination and the resolved origin for this nearby search. */
                        metadata: {
                            /** @description Number of results on the current page (always <= pageSize). */
                            resultCount: number;
                            /** @description Rows the upstream returned before this page was sliced. The upstream ignores per_page and answers with roughly ten rows, so pageSize can only narrow this, never reach further. */
                            totalCandidates: number;
                            /** @description True when pageSize clipped the upstream rows. */
                            hasMore: boolean;
                            /** @description The point the nearby search ran from, and how it was derived. */
                            origin: {
                                /** @description Latitude the upstream was queried with. */
                                latitude: number;
                                /** @description Longitude the upstream was queried with. */
                                longitude: number;
                                /**
                                 * @description `place` when a code was resolved to these coordinates, `coordinates` when the caller supplied them.
                                 * @enum {string}
                                 */
                                resolvedFrom: "place" | "coordinates";
                                /** @description The resolved place code, present only when resolvedFrom is place. */
                                code?: string;
                                /** @description The resolved place name, present only when resolvedFrom is place. */
                                name?: string;
                            };
                        };
                    };
                };
            };
            /** @description Neither a place nor a coordinate pair, an out-of-range coordinate, or a place code that resolves to nothing with coordinates. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream places service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The places service is temporarily unavailable; retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getPlaces: {
        parameters: {
            query: {
                /** @description Free text to resolve to typed places with codes. A place-name search (city, airport, district, hotel). */
                query: string;
                /** @description Place types to resolve; repeat or comma-separate to mix. */
                types?: ("city" | "airport" | "state" | "district" | "hotel")[];
                /** @description Language tag for localized place names (e.g. en, ar). Omitted, the search is language-neutral: the query matches names in any language (sent upstream as the locale wildcard) and results carry canonical English names. Pass a tag to localize the returned names instead. getNearbyPlaces, by contrast, defaults to en. */
                locale?: string;
                /** @description Page number, 1-based (max 100). Defaults to 1. */
                page?: number;
                /** @description Results per page (1-50). Defaults to 10. */
                pageSize?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Matching places plus pagination/ambiguity metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The matched places for this page. */
                        results: {
                            /** @description Opaque identifier, unique per place. Do not send it to other endpoints or build wego.com URLs from it: reference a place by code, or by cityCode for a hotels search. */
                            id?: number | string;
                            /** @description IATA-style code (airport/city), when the place has one. */
                            code?: string;
                            /** @description Display name of the place. */
                            name: string;
                            /** @description Place kind: city, airport, state, district or hotel. */
                            type: string;
                            /** @description Code of the city this place belongs to. */
                            cityCode?: string;
                            /** @description Latitude in decimal degrees, when known. */
                            latitude?: number;
                            /** @description Longitude in decimal degrees, when known. */
                            longitude?: number;
                        }[];
                        /** @description Pagination and ambiguity signals for this place search. */
                        metadata: {
                            /** @description Number of results on the current page (always <= pageSize). */
                            resultCount: number;
                            /** @description Total matches held for this query (post-dedup, pre-pagination) – the ceiling pagination can reach. 0 means no matches; an empty deep page with totalCandidates > 0 just means the offset is past the end. */
                            totalCandidates: number;
                            /** @description True when a further page exists. */
                            hasMore: boolean;
                            /** @description True when several distinct real-world locations share the query; ask the user to disambiguate before searching. */
                            hasAmbiguity: boolean;
                            /** @description Short clarification sample, present only when hasAmbiguity. */
                            disambiguationHint?: string;
                        };
                    };
                };
            };
            /** @description Invalid query parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream places service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The places service is temporarily unavailable; retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getCountryHolidays: {
        parameters: {
            query?: {
                /** @description Inclusive ISO start date. Give both fromDate and toDate, or neither. */
                fromDate?: string;
                /** @description Inclusive ISO end date. Give both fromDate and toDate, or neither. */
                toDate?: string;
                /** @description Locale for localized names (e.g. en, ar). Defaults to en. */
                locale?: string;
            };
            header?: never;
            path: {
                /** @description ISO 3166-1 alpha-2 code of the Wego market whose public holidays you want (e.g. AE). A destination MARKET, not a passport: it must be one of Wego's markets, and an unknown one is rejected 400. The same path segment means a passport on the visa-free route. */
                countryCode: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Holidays in the searched range, plus that range. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Public holidays in the resolved window. */
                        results: {
                            /** @description Localized holiday name. */
                            name: string;
                            /** @description Stable upstream slug (e.g. national_day) – the same holiday carries the same key across locales. */
                            key: string;
                            /** @description Inclusive ISO YYYY-MM-DD start. */
                            startDate: string;
                            /** @description Inclusive ISO YYYY-MM-DD end; equals startDate for one-day holidays. */
                            endDate: string;
                        }[];
                        /** @description The market, the resolved date window, and the result count for this read. */
                        metadata: {
                            /** @description Number of holidays returned. */
                            resultCount: number;
                            /** @description The market the holidays are for. */
                            countryCode: string;
                            /**
                             * @description `explicit` when the caller supplied both dates, `upcoming` when the API chose the range (stated in from/to).
                             * @enum {string}
                             */
                            window: "explicit" | "upcoming";
                            /** @description Inclusive ISO start of the range actually searched. */
                            from: string;
                            /** @description Inclusive ISO end of the range actually searched. */
                            to: string;
                        };
                    };
                };
            };
            /** @description Unknown market, malformed date, only one of fromDate/toDate, or fromDate after toDate. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream holidays service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The holidays service is temporarily unavailable; retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getVisaFreeDestinations: {
        parameters: {
            query?: {
                /** @description Locale for localized names (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Page number, 1-based (max 20). Defaults to 1. The list is a bounded registry the API assembles whole, so paging is rarely needed and the cap is low by design. */
                page?: number;
                /** @description Rows per page (1-200). Defaults to 200, which is also the maximum: this is a bounded registry the API walks completely, so the default returns the whole list. pageSize exists only to narrow a long answer, never to force paging. */
                pageSize?: number;
            };
            header?: never;
            path: {
                /** @description ISO 3166-1 alpha-2 code of the PASSPORT whose visa-free destinations you want (e.g. AE). A passport, not a market: any well-formed code is accepted (a passport need not be a Wego market) and an unrecognized one returns an honest empty list. The same path segment means a market on the holidays route. */
                countryCode: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Visa-free destinations for this passport, keyed on countryCode for joining. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Visa-free destinations for the passport. */
                        results: {
                            /** @description ISO 3166-1 alpha-2 code – the key to join this list on. */
                            countryCode: string;
                            /** @description Localized country name. */
                            name: string;
                            /** @description The country's principal city code, ready for a flight search. */
                            keyCityCode?: string;
                            /** @description The destination's ISO 4217 currency code, when known. */
                            currencyCode?: string;
                            /** @description Latitude of the destination's principal city, when known. */
                            latitude?: number;
                            /** @description Longitude of the destination's principal city, when known. */
                            longitude?: number;
                        }[];
                        /** @description The passport, the walk's coverage, and the counts for this read. */
                        metadata: {
                            /** @description Number of destinations on the current page. */
                            resultCount: number;
                            /** @description Destinations assembled across every upstream page, pre-pagination. 0 means Wego lists none for this passport – NOT that a visa is required. */
                            totalCandidates: number;
                            /** @description True when a further page exists. */
                            hasMore: boolean;
                            /** @description The passport the list is for. */
                            passportCountryCode: string;
                            /** @description How many upstream pages were read to assemble this list. */
                            upstreamPagesFetched: number;
                            /**
                             * @description `complete` when the walk ended on a short upstream page. `truncated` when the page cap stopped it on a full page, so totalCandidates is a FLOOR and destinations may exist that this response does not carry. At exactly the cap (200) a complete list also reports `truncated`, since telling the two apart would cost another upstream page.
                             * @enum {string}
                             */
                            coverage: "complete" | "truncated";
                        };
                    };
                };
            };
            /** @description Malformed passport country code, page or pageSize. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream destinations service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The destinations service is temporarily unavailable; retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createFlightSearch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Origin airport or city IATA code, e.g. DXB.
                     * @example DXB
                     */
                    from: string;
                    /**
                     * @description Destination airport or city IATA code, e.g. LHR.
                     * @example LHR
                     */
                    to: string;
                    /** @description Outbound departure date, YYYY-MM-DD. Not in the past, within a year. */
                    fromDate: string;
                    /** @description Return date, YYYY-MM-DD. Omit for a one-way search. */
                    toDate?: string;
                    /**
                     * @description Cabin class requested for all passengers.
                     * @default economy
                     * @enum {string}
                     */
                    cabin?: "economy" | "premium_economy" | "business" | "first";
                    /**
                     * @description Adult passengers (1-9). Defaults to 1. Note the hotel search defaults adults to 2, since a room sleeps two.
                     * @default 1
                     */
                    adults?: number;
                    /**
                     * @description Child passengers (0-8). Defaults to 0.
                     * @default 0
                     */
                    children?: number;
                    /**
                     * @description Infant passengers (0-8). Must not exceed adults. Defaults to 0.
                     * @default 0
                     */
                    infants?: number;
                    /**
                     * @description Pricing currency as a 3-letter ISO 4217 code. Defaults to USD.
                     * @default USD
                     */
                    currency?: string;
                    /**
                     * @description Response language tag (e.g. en, ar). Defaults to en.
                     * @default en
                     */
                    locale?: string;
                    /** @description Wego market (point of sale) as a 2-letter code, e.g. AE. Optional: if omitted the API defaults to US. A client that knows the user's market (the wego CLI derives it from the id_token) passes it as an explicit siteCode; the response always reports the siteCode used. */
                    siteCode?: string;
                };
            };
        };
        responses: {
            /** @description Search created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The id of the created search; pass it to the results and trip reads. */
                        searchId: string;
                        /** @description The site code (Wego market) the search was created for. */
                        siteCode: string;
                        /**
                         * @description How the API resolved siteCode: explicit (caller-supplied – including a market a client derived and passed) or default (US, no site supplied).
                         * @enum {string}
                         */
                        siteCodeSource: "explicit" | "default";
                    };
                };
            };
            /** @description Invalid request body/query/path parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream flights service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The flights service is temporarily unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFlightSchedules: {
        parameters: {
            query: {
                /** @description Departure city or airport code; an airport resolves to its city. */
                from: string;
                /** @description Arrival city or airport code; an airport resolves to its city. */
                to: string;
                /** @description Filter to one marketing carrier (e.g. SQ). */
                airline?: string;
                /** @description Wego market as a 2-letter code. Omitted, the API defaults to US and says so in metadata.siteCodeSource. */
                siteCode?: string;
                /** @description Response language tag. */
                locale?: string;
                /** @description Page number, 1-based (max 20). Defaults to 1. A timetable is a bounded list the API reads whole, so paging is rarely needed and the cap is low by design. */
                page?: number;
                /** @description Rows per page (1-200). Defaults to 200, which is also the maximum, so most routes return whole on one page. A busier route exceeds it and says so with hasMore. pageSize exists to narrow a long answer, never to force paging. */
                pageSize?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Scheduled flights, plus the resolved route and the market used. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The scheduled flights for this route, a timetable with no prices. */
                        results: {
                            /** @description Marketing carrier code – what `airline` filters on. */
                            airlineCode: string;
                            /** @description Departure airport IATA code. */
                            departureAirportCode: string;
                            /** @description Arrival airport IATA code. */
                            arrivalAirportCode: string;
                            /** @description Local HH:MM at the departure airport. */
                            departureTime: string;
                            /** @description Local HH:MM at the arrival airport. */
                            arrivalTime: string;
                            /** @description Total scheduled duration in minutes. */
                            durationMinutes: number;
                            /** @description Stops on the route, as the timetable reports them; 0 is nonstop. This read covers nonstop scheduled flights, so a connecting itinerary is absent rather than listed with a stop. */
                            stopsCount: number;
                            /** @description Days the arrival falls after departure; 1 means next-day. */
                            arrivalDayOffset: number;
                            /** @description The individual flights that make up this schedule. */
                            segments: {
                                /** @description Departure airport IATA code. */
                                departureAirportCode: string;
                                /** @description Arrival airport IATA code. */
                                arrivalAirportCode: string;
                                /** @description Local HH:MM at the departure airport. */
                                departureTime: string;
                                /** @description Local HH:MM at the arrival airport. */
                                arrivalTime: string;
                                /** @description Marketing carrier IATA code. */
                                airlineCode: string;
                                /** @description Marketing carrier display name, when resolved. */
                                airlineName?: string;
                                /** @description Segment duration in minutes, when reported. */
                                durationMinutes?: number;
                                /** @description The marketed designator, e.g. `TR 610`. */
                                flightNumber?: string;
                                /** @description Aircraft type code, when reported. */
                                aircraftCode?: string;
                                /** @description Aircraft type name, when reported. */
                                aircraftName?: string;
                            }[];
                            /** @description When this flight runs – one entry per published operating period. Empty when the upstream states no recurrence, which means unknown, never daily. */
                            operatingPeriods: {
                                /** @description Days of the week the flight operates, 1 Monday to 7 Sunday. Absent means the upstream published no recurrence for this period. */
                                weekdays?: number[];
                                /** @description First date this recurrence is published for, as YYYY-MM-DD. */
                                startDate?: string;
                                /** @description Last date this recurrence is published for, as YYYY-MM-DD. */
                                endDate?: string;
                            }[];
                            /** @description The marketed designator, present on a single-segment schedule. */
                            flightNumber?: string;
                            /** @description Aircraft type code, when reported. */
                            aircraftCode?: string;
                        }[];
                        /** @description The page returned, how much the upstream held, the resolved route endpoints, and the market echoed. */
                        metadata: {
                            /** @description The 1-based page returned. */
                            page: number;
                            /** @description Rows requested per page. */
                            pageSize: number;
                            /** @description Scheduled flights on this page (always <= pageSize). */
                            resultCount: number;
                            /** @description Scheduled flights the upstream held for this route, pre-pagination – the ceiling paging can reach. 0 means the upstream publishes no timetable for this route, NOT that nothing flies it. */
                            totalCandidates: number;
                            /** @description True when a further page exists. */
                            hasMore: boolean;
                            /**
                             * @description complete when the upstream returned its whole set for this route, truncated when it filled the API's upstream ceiling and may hold more. While truncated, read totalCandidates as a floor rather than a total.
                             * @enum {string}
                             */
                            coverage: "complete" | "truncated";
                            /** @description Departure route endpoint: what the caller sent and the city code it resolved to. */
                            from: {
                                /** @description Exactly what the caller sent, uppercased. */
                                requested: string;
                                /** @description The city code sent upstream – LHR resolves to LON. */
                                resolvedCityCode: string;
                            };
                            /** @description Arrival route endpoint: what the caller sent and the city code it resolved to. */
                            to: {
                                /** @description Exactly what the caller sent, uppercased. */
                                requested: string;
                                /** @description The city code sent upstream – LHR resolves to LON. */
                                resolvedCityCode: string;
                            };
                            /** @description The market this request resolved to, as a 2-letter code. Echoed for consistency with the priced reads – a published timetable does not vary by market, so it does not change these rows. */
                            siteCode: string;
                            /**
                             * @description explicit when the caller supplied siteCode, default when the API applied the US floor.
                             * @enum {string}
                             */
                            siteCodeSource: "explicit" | "default";
                        };
                    };
                };
            };
            /** @description Malformed code, a code that resolves to no city, or a page or pageSize outside its range – an out-of-range paging value is rejected, never clamped. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream schedules service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The schedules service is temporarily unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFlightSearchResults: {
        parameters: {
            query?: {
                /** @description Page number, 1-based (max 100). */
                page?: number;
                /** @description Results per page (default 10, max 50); out-of-range values are rejected with 400, never clamped. */
                pageSize?: number;
                /** @description Sort mode; score_desc (default) ranks by the metasearch score, the leg1/leg2 modes sort by that leg's local departure time. */
                sort?: "score_desc" | "price_asc" | "duration_asc" | "leg1_departure_time_asc" | "leg1_departure_time_desc" | "leg2_departure_time_asc" | "leg2_departure_time_desc";
                /** @description Airline IATA codes, repeat or comma-separate (e.g. ?airlines=SQ,TR). Values are OR'd together; by default a trip matches if ANY leg (outbound or return) carries any listed airline, not a trip-wide AND. Pass airlines-match=all for the trip-wide AND that wego.com applies. */
                airlines?: string[];
                /** @description How the airlines list is matched across a trip's legs. 'any' (the default) keeps a trip when ANY leg carries a listed airline. 'all' requires EVERY leg to, which is what wego.com does, so a Saudia-out / Emirates-back trip is dropped under ?airlines=EK. A leg marketed by two carriers still passes when one of them is listed, so add same-airline=true to require a single carrier as well. Ignored when airlines is absent. */
                "airlines-match"?: "any" | "all";
                /** @description Keep only trips where every leg is marketed by exactly ONE airline and it is the same airline on every leg, so an interline or self-transfer leg marketed by two carriers is dropped. Matches the MARKETING carrier only: a codeshare, where one airline sells a flight another operates, is NOT excluded, because wego.com's 'same airline for the complete trip' does not exclude it either. Independent of airlines, so it works on its own; combine the two to mean 'only SQ, on every leg'. */
                "same-airline"?: "0" | "1" | "true" | "false";
                /** @description Alliance codes, repeat or comma-separate. OR'd together; a trip matches if ANY leg (outbound or return) belongs to any listed alliance. Case-insensitive. NOT a fixed set – read metadata.filterOptions.alliances for this snapshot's own values, which include upstream groupings that are not strictly alliances (lcc for low-cost carriers, value_alliance). An unknown code matches nothing rather than failing the request. */
                alliances?: string[];
                /** @description Stop counts, repeat or comma-separate (e.g. ?stops=0,1). OR'd together; matched against the trip-level stop count (the MAX across legs, i.e. the value the response's stops field exposes) – not a per-leg check, so a mixed-stop round trip (e.g. a direct outbound + a 1-stop return) is kept under ?stops=1. */
                stops?: number[];
                /** @description Minimum cheapest-fare total price (inclusive), in the response currency. */
                "min-price"?: number;
                /** @description Maximum cheapest-fare total price (inclusive), in the response currency. */
                "max-price"?: number;
                /** @description Maximum total trip duration in minutes (inclusive). */
                "max-duration"?: number;
                /** @description Minimum layover time in minutes (inclusive), a floor on a trip's WORST leg. Judged per trip on the LARGEST leg total across its legs, the same fold stops applies, NOT on an individual connection: a leg with two 40-minute connections totals 80 and passes ?min-stopover-duration=60. A DIRECT trip has no layover, so it totals 0 and is DROPPED by any minimum above 0 - combine with ?stops=0 only if you want both. A trip whose layover upstream never stated is dropped by either bound rather than assumed to be 0. Read metadata.filterOptions.stopoverDurations for the span this snapshot carries, and judge the result on metadata.totalCandidates, never on the page. */
                "min-stopover-duration"?: string;
                /** @description Maximum layover time in minutes (inclusive), a ceiling on a trip's worst leg. It bounds how LONG a wait is, never when it falls: a 135-minute wait beginning 04:00 is under any sane ceiling and is still an overnight one, and a 465-minute wait beginning 11:00 is over it and never sees a night. To answer whether a wait falls overnight, read the connection's own clock from GET /v1/flights/trips/{tripId}?view=detail, whose segments carry arrivesAt and departsAt. Judged per trip on the LARGEST leg total across its legs, NOT on an individual connection: a 2-stop leg waiting 450 then 510 totals 960 and is dropped by ?max-stopover-duration=600 even though neither connection exceeds it. Direct trips total 0, so every maximum keeps them. Each card's legs[].layoverMinutesByStop carries the per-connection breakdown that sums to the total judged here. Read metadata.filterOptions.stopoverDurations for the span this snapshot carries, and judge the result on metadata.totalCandidates, never on the page. */
                "max-stopover-duration"?: string;
                /** @description Coarse local-time buckets for the OUTBOUND leg's DEPARTURE: midnight 00:00-05:59, morning 06:00-11:59, afternoon 12:00-17:59, night 18:00-23:59, local to that airport. Repeat or comma-separate; OR'd together. The four buckets PARTITION the day, so listing all four returns every trip exactly once - wego.com's own buckets overlap at 06:00, 12:00 and 18:00 and these do not. They are wider than they sound, so prefer the matching -range param whenever the caller gave a hard edge. */
                "outbound-departure-blocks"?: ("midnight" | "morning" | "afternoon" | "night")[];
                /** @description Minute-of-day window `min-max` (each 0-1439, local to that airport), both ends inclusive. When min > max the window wraps past midnight, e.g. 1320-360 means 22:00-06:00. Bounds the OUTBOUND leg's DEPARTURE, local to the departure airport. */
                "outbound-departure-range"?: string;
                /** @description Coarse local-time buckets for when the OUTBOUND leg LANDS: midnight 00:00-05:59, morning 06:00-11:59, afternoon 12:00-17:59, night 18:00-23:59, local to that airport. Repeat or comma-separate; OR'd together. The four buckets PARTITION the day, so listing all four returns every trip exactly once - wego.com's own buckets overlap at 06:00, 12:00 and 18:00 and these do not. They are wider than they sound, so prefer the matching -range param whenever the caller gave a hard edge. */
                "outbound-arrival-blocks"?: ("midnight" | "morning" | "afternoon" | "night")[];
                /** @description Minute-of-day window `min-max` (each 0-1439, local to that airport), both ends inclusive. When min > max the window wraps past midnight, e.g. 1320-360 means 22:00-06:00. Bounds when the OUTBOUND leg LANDS, local to the ARRIVAL airport - this is the param for "get me in before midnight" or "nothing that lands at 4am". Judged on the clock ALONE, not the calendar: a red-eye landing 04:00 the NEXT day reads as minute 240 and is dropped by 360-1320 exactly as a same-day 04:00 landing would be, and kept by 0-1080 exactly as a same-day one would be. Read each card's legs[].arrivalDayOffset to tell the two apart. */
                "outbound-arrival-range"?: string;
                /** @description Coarse local-time buckets for the RETURN leg's DEPARTURE: midnight 00:00-05:59, morning 06:00-11:59, afternoon 12:00-17:59, night 18:00-23:59, local to that airport. Repeat or comma-separate; OR'd together. The four buckets PARTITION the day, so listing all four returns every trip exactly once - wego.com's own buckets overlap at 06:00, 12:00 and 18:00 and these do not. They are wider than they sound, so prefer the matching -range param whenever the caller gave a hard edge. Applies to the RETURN leg (legs[1]) ONLY. A ONE-WAY search has no return leg, so any return-* bound judges a leg that does not exist and matches NOTHING - expect metadata.totalCandidates 0, which is the honest answer rather than a silently ignored filter. Judge the result on metadata.totalCandidates, never on the page. */
                "return-departure-blocks"?: ("midnight" | "morning" | "afternoon" | "night")[];
                /** @description Minute-of-day window `min-max` (each 0-1439, local to that airport), both ends inclusive. When min > max the window wraps past midnight, e.g. 1320-360 means 22:00-06:00. Bounds the RETURN leg's DEPARTURE, local to that leg's departure airport. Applies to the RETURN leg (legs[1]) ONLY. A ONE-WAY search has no return leg, so any return-* bound judges a leg that does not exist and matches NOTHING - expect metadata.totalCandidates 0, which is the honest answer rather than a silently ignored filter. Judge the result on metadata.totalCandidates, never on the page. */
                "return-departure-range"?: string;
                /** @description Coarse local-time buckets for when the RETURN leg LANDS, i.e. when the traveller gets home: midnight 00:00-05:59, morning 06:00-11:59, afternoon 12:00-17:59, night 18:00-23:59, local to that airport. Repeat or comma-separate; OR'd together. The four buckets PARTITION the day, so listing all four returns every trip exactly once - wego.com's own buckets overlap at 06:00, 12:00 and 18:00 and these do not. They are wider than they sound, so prefer the matching -range param whenever the caller gave a hard edge. Applies to the RETURN leg (legs[1]) ONLY. A ONE-WAY search has no return leg, so any return-* bound judges a leg that does not exist and matches NOTHING - expect metadata.totalCandidates 0, which is the honest answer rather than a silently ignored filter. Judge the result on metadata.totalCandidates, never on the page. */
                "return-arrival-blocks"?: ("midnight" | "morning" | "afternoon" | "night")[];
                /** @description Minute-of-day window `min-max` (each 0-1439, local to that airport), both ends inclusive. When min > max the window wraps past midnight, e.g. 1320-360 means 22:00-06:00. Bounds when the RETURN leg LANDS, local to the ARRIVAL airport - the "home before 22:00" bound. Judged on the clock alone, not the calendar; read legs[].arrivalDayOffset to tell a next-day landing apart. Applies to the RETURN leg (legs[1]) ONLY. A ONE-WAY search has no return leg, so any return-* bound judges a leg that does not exist and matches NOTHING - expect metadata.totalCandidates 0, which is the honest answer rather than a silently ignored filter. Judge the result on metadata.totalCandidates, never on the page. */
                "return-arrival-range"?: string;
                /** @description Minimum elapsed duration of the OUTBOUND leg in minutes (inclusive). Bounds ONE leg, unlike max-duration which bounds the whole trip. */
                "outbound-min-duration"?: string;
                /** @description Maximum elapsed duration of the OUTBOUND leg in minutes (inclusive). Bounds ONE leg, unlike max-duration which bounds the whole trip: a 3h outbound paired with a 14h return passes ?outbound-max-duration=300 and no trip-wide ceiling can express that. */
                "outbound-max-duration"?: string;
                /** @description Minimum elapsed duration of the RETURN leg in minutes (inclusive). Applies to the RETURN leg (legs[1]) ONLY. A ONE-WAY search has no return leg, so any return-* bound judges a leg that does not exist and matches NOTHING - expect metadata.totalCandidates 0, which is the honest answer rather than a silently ignored filter. Judge the result on metadata.totalCandidates, never on the page. */
                "return-min-duration"?: string;
                /** @description Maximum elapsed duration of the RETURN leg in minutes (inclusive). Bounds ONE leg, unlike max-duration which bounds the whole trip. Applies to the RETURN leg (legs[1]) ONLY. A ONE-WAY search has no return leg, so any return-* bound judges a leg that does not exist and matches NOTHING - expect metadata.totalCandidates 0, which is the honest answer rather than a silently ignored filter. Judge the result on metadata.totalCandidates, never on the page. */
                "return-max-duration"?: string;
                /** @description Booking types, repeat or comma-separate. OR'd together across the trip's fares – a trip matches if ANY of its fares has a listed kind (partner fares never match either value). */
                "booking-types"?: ("wego" | "airline")[];
                /** @description Provider codes, repeat or comma-separate. OR'd together across the trip's fares – a trip matches if ANY of its fares comes from a listed provider. */
                "booking-sites"?: string[];
                /** @description Stopover airport IATA codes, repeat or comma-separate. OR'd together; a trip matches if ANY leg (outbound or return) stops over at any listed airport. */
                "stopover-airports"?: string[];
                /** @description Aircraft type CODES, repeat or comma-separate (e.g. ?aircraft=380,789). OR'd together; a trip matches if ANY leg (outbound or return) flies any listed type. These are upstream's short equipment codes (380, 789, 32N), NOT the display labels the results card publishes (A380, B787-9, A320 Neo) – read metadata.filterOptions.aircraft for this snapshot's codes and the label beside each one. Several codes can share one label (321 and 32S are both A321), which is why the code is the filter key. Case-insensitive. NOT a fixed set; an unknown code matches nothing rather than failing the request. */
                aircraft?: string[];
                /** @description Pricing currency as a 3-letter ISO 4217 code (e.g. AED). Optional; defaults to USD server-side. Not inherited from the search: a search created in one currency reads back in USD unless you pass currency on every read, so re-send the search's currency to keep prices in it. */
                currency?: string;
                /** @description Response language tag (e.g. en, ar). Optional; defaults to en server-side. Not inherited from the search – pass it on each read to keep results in that language. */
                locale?: string;
                /** @description Response projection. `card` is the only value: the lean results-list projection (cheapest-price summary + trip-level stops/duration + per-leg airline/aircraft/stopover, no fares[]). The former `default` projection was removed in issue #1308 – read GET /v1/flights/trips/{tripId} for a trip's fares and segments. */
                view?: "card";
            };
            header?: never;
            path: {
                /** @description The opaque searchId returned by createFlightSearch. Ids expire (a few minutes); a 404 means the search is gone – create a new one. */
                searchId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current ranked-trip snapshot, as list cards. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The id of the search this snapshot belongs to. */
                        searchId: string;
                        /** @description The currency the prices in this snapshot actually came back in, read off the fares themselves – so this, not metadata.currencyCode, is what a displayed number is denominated in. metadata.currencyCode reports what the read asked for and carries currencyCodeSource beside it; the two agree unless upstream declined to reprice into the requested currency. */
                        currencyCode: string;
                        /** @description Pagination, the snapshot's filter vocabulary, the settle counters for this read, and what it resolved currency and locale to. */
                        metadata: {
                            /** @description 1-based page number of this snapshot. */
                            page: number;
                            /** @description Trips requested per page. */
                            pageSize: number;
                            /** @description Trips on this page. The page only – judge a filter on totalCandidates, not this. */
                            resultCount: number;
                            /** @description Trips matching this read's filters across the whole snapshot – the count that judges a filter, never the page (results). Flights have no completion flag: settle on snapshotFareCount steady across two reads with snapshotTripCount above 0. */
                            totalCandidates: number;
                            /** @description Another page of trips follows. */
                            hasMore: boolean;
                            /** @description The filter values this snapshot actually carries, ordered by count, over the same trips as snapshotTripCount. Codes are what the matching query param accepts, so pick from here rather than guessing: sending one listed code with no other filter makes metadata.totalCandidates equal that count exactly. It does NOT bound results, which stays the requested page, so compare against totalCandidates and not resultCount. Counts assume the default matching, so airlines-match=all or same-airline=true can keep fewer trips than the airlines count promises. count is trips, not legs or fares, and a trip is counted once however many of its legs or fares carry the value, including when only its return leg does. name is the display label: always present on bookingSites, where the provider code is its own fallback, present on airlines and stopoverAirports only when the snapshot dictionary resolves the code, and never present on alliances, which upstream gives no label. Still growing while the search aggregates, so judge an ABSENT code only once snapshotFareCount holds steady across two reads. */
                            filterOptions: {
                                /** @description Alliance codes present in this snapshot, by descending count. */
                                alliances: {
                                    /** @description The code the matching filter query param accepts. */
                                    code: string;
                                    /** @description Display label for the code, when the snapshot dictionary resolves one. */
                                    name?: string;
                                    /** @description Trips carrying this value, deduped per trip and matched on any leg. */
                                    count: number;
                                }[];
                                /** @description Airline codes present in this snapshot, by descending count. */
                                airlines: {
                                    /** @description The code the matching filter query param accepts. */
                                    code: string;
                                    /** @description Display label for the code, when the snapshot dictionary resolves one. */
                                    name?: string;
                                    /** @description Trips carrying this value, deduped per trip and matched on any leg. */
                                    count: number;
                                }[];
                                /** @description Booking provider codes present in this snapshot, by descending count. */
                                bookingSites: {
                                    /** @description The code the matching filter query param accepts. */
                                    code: string;
                                    /** @description Display label for the code, when the snapshot dictionary resolves one. */
                                    name?: string;
                                    /** @description Trips carrying this value, deduped per trip and matched on any leg. */
                                    count: number;
                                }[];
                                /** @description Stopover airport codes present in this snapshot, by descending count. */
                                stopoverAirports: {
                                    /** @description The code the matching filter query param accepts. */
                                    code: string;
                                    /** @description Display label for the code, when the snapshot dictionary resolves one. */
                                    name?: string;
                                    /** @description Trips carrying this value, deduped per trip and matched on any leg. */
                                    count: number;
                                }[];
                                /** @description Aircraft type codes present in this snapshot, by descending count. name is the display label the results card publishes (A380, A320 Neo), and is NOT unique: several codes can carry the same label, so filter on code. Includes any non-aircraft equipment upstream reports on a leg, such as BUS for a surface segment. */
                                aircraft: {
                                    /** @description The code the matching filter query param accepts. */
                                    code: string;
                                    /** @description Display label for the code, when the snapshot dictionary resolves one. */
                                    name?: string;
                                    /** @description Trips carrying this value, deduped per trip and matched on any leg. */
                                    count: number;
                                }[];
                                /** @description The layover span this snapshot carries, in minutes, measured the way min-stopover-duration and max-stopover-duration are judged: per trip, the LARGEST leg total across its legs. Use it to bound a slider. Both ends are reachable - sending the published min or max with no other filter keeps at least the trip that set it. min is 0 whenever the snapshot holds one direct trip, which is the usual case. A range, not a count list, so it has no name or count. Absent when nothing here is measurable: an empty snapshot, or one where every trip carries a connecting leg whose layover upstream never stated. */
                                stopoverDurations?: {
                                    /** @description Shortest layover any trip in this snapshot carries, in minutes. 0 whenever one trip is direct. Echoes the upstream figure, so it is a whole number of minutes wherever upstream states one. */
                                    min: number;
                                    /** @description Longest layover any trip in this snapshot carries, in minutes. */
                                    max: number;
                                };
                            };
                            /** @description Renderable trips before filter/sort/page. 0 means upstream has produced none yet; above 0 beside an empty `results` means a filter or page range excluded everything. Settling needs `snapshotFareCount` steady across two reads AND this above 0. */
                            snapshotTripCount: number;
                            /** @description Upstream progress counter, for cross-read comparison only. Runs ahead of the fares returned and stays non-zero over an empty page, so read `resultCount`/`totalCandidates` for display. Settled = equal non-zero across two reads with `snapshotTripCount` above 0. */
                            snapshotFareCount: number;
                            /** @description When the upstream search was created (ISO 8601) – the freshness anchor for these prices. Absent when upstream omits it. */
                            createdAt?: string;
                            /** @description The currency this read ASKED upstream for, and the one every price on it is meant to be in. Read it beside currencyCodeSource before you show a number: a price computed in the wrong currency renders as a perfectly normal price, with no error and no odd shape to notice, so the response states which one rather than leaving it to be inferred. Where the operation also publishes a top-level currencyCode, that field reports the currency the prices actually came back in; the two agree unless upstream declined to reprice. */
                            currencyCode: string;
                            /**
                             * @description How the API resolved currencyCode: explicit (the caller sent currency – including a value equal to the default) or default (USD, no currency sent). A default here is the one signal that the request never carried the currency you meant.
                             * @enum {string}
                             */
                            currencyCodeSource: "explicit" | "default";
                            /** @description The language tag this read asked upstream for – what any localized text on it was resolved in (room and board names, airline and airport names, review prose). */
                            locale: string;
                            /**
                             * @description How the API resolved locale: explicit (the caller sent locale – including a value equal to the default) or default (en, no locale sent). A default here explains text that came back in a language the caller did not ask for.
                             * @enum {string}
                             */
                            localeSource: "explicit" | "default";
                        };
                        /** @description The requested page of ranked trips, as list cards. */
                        results: {
                            /** @description Opaque trip id; read it back with GET /v1/flights/trips/{tripId}. */
                            tripId: string;
                            /** @description Every featured label that fits this trip. best_value ranks on the score of the trip's CHEAPEST fare, the same statistic sort=score_desc orders by; cheapest and cheapest_direct break a price tie by that score, then by leg-1 departure – cheapest keeps the LATER departure, cheapest_direct the EARLIER one. */
                            badges: ("best_value" | "cheapest" | "cheapest_direct")[];
                            /** @description Trip-level stop count – the MAX across legs, the same value ?stops= filters on. Do not fold legs[] yourself. */
                            stops: number;
                            /** @description Trip-level duration – the SUM across legs. */
                            durationMinutes: number;
                            /** @description Card price summary – the cheapest whole-party total, fee-inclusive; scope names the (party) figure. */
                            price: {
                                /** @description The cheapest fare's whole-party total (upstream totalAmount), including payment + booking fees. */
                                total: number;
                                /** @description ISO 4217 currency of total. */
                                currency: string;
                                /**
                                 * @description total covers the whole party (adults + children + infants), not per-person.
                                 * @constant
                                 */
                                scope: "party";
                                /** @description How many providers/fares sell this trip ("from 11 websites"). */
                                websiteCount: number;
                                /** @description Whether any of the trip's fares is a Book-on-Wego fare. */
                                hasWegoFare: boolean;
                            };
                            /** @description Per-leg summary for this trip, outbound first then return. */
                            legs: {
                                /** @description Departure airport IATA code. */
                                from: string;
                                /** @description Arrival airport IATA code. */
                                to: string;
                                /** @description Leg departure, ISO 8601 with offset. */
                                departsAt: string;
                                /** @description Leg arrival, ISO 8601 with offset. */
                                arrivesAt: string;
                                /** @description Calendar days the arrival lands after departure (the +1 badge). */
                                arrivalDayOffset: number;
                                /** @description The leg spans a night. */
                                overnight: boolean;
                                /** @description Leg duration in minutes. */
                                durationMinutes: number;
                                /** @description Stops on this leg (0 is nonstop). */
                                stops: number;
                                /** @description Stopover airport codes ("via KUL"); empty for a direct leg. */
                                via: string[];
                                /** @description Layover minutes per connection, index-aligned to via, so layoverMinutesByStop[i] is the wait at via[i]. Absent on a direct leg, and absent on a leg whose upstream segment list does not line up with via, where publishing it could pair a wait with the wrong airport. Named apart from the trip read's legs[].layoverMinutes, which is a single leg TOTAL rather than a per-connection list. Sums to the leg total that min-stopover-duration and max-stopover-duration are judged against; those params bound the LARGEST leg total across the trip's legs, not an individual connection, so a trip kept by max-stopover-duration can still carry one long wait among several short ones. */
                                layoverMinutesByStop?: number[];
                                /** @description Marketing airlines on the leg, resolved to code, name and logo. */
                                airlines: {
                                    /** @description IATA airline code. */
                                    code: string;
                                    /** @description Airline display name. */
                                    name: string;
                                    /** @description Airline logo URL; may 404, fall back to the name. */
                                    logoUrl: string;
                                }[];
                                /** @description Carriers that fly a segment of this leg they do not market. airlines names the MARKETING carriers only, so on a leg sold by one airline every code here is a carrier absent from the ticket; on an interline leg sold by two, one of these may also market a different segment. Read this before telling a traveller who they fly. This card carries no segments[], so read the trip for which flight each one operates. PRESENT ONLY WHEN A SEGMENT PROVES A CODESHARE: absent means none was proven on this leg, never a promise that the marketing carrier operates every segment. */
                                operatingAirlines?: {
                                    /** @description IATA airline code. */
                                    code: string;
                                    /** @description Airline display name. */
                                    name: string;
                                    /** @description Airline logo URL; may 404, fall back to the name. */
                                    logoUrl: string;
                                }[];
                                /** @description Distinct aircraft short names across the leg ("A330","B787"). Equipment only: a surface segment does show up here as its equipment label ("Bus"), but transportTypes is the field that states the mode. */
                                aircraft: string[];
                                /** @description Distinct transport modes across this leg's segments, in segment order. Always present and never empty: an all-flight leg reads ["FLIGHT"]. This card carries no segments[], so anything else here means read the trip to see which segment is not a plane before you quote the leg as a flight. */
                                transportTypes: ("FLIGHT" | "TRAIN" | "BUS" | "OTHER")[];
                            }[];
                        }[];
                    };
                };
            };
            /** @description Invalid request body/query/path parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown or expired search. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream flights service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The flights service is temporarily unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFlightTrip: {
        parameters: {
            query: {
                /** @description Required search context: the searchId the tripId was read from (it is the tripId's first :-segment). A trip id resolves only with its own search, and both expire together. */
                searchId: string;
                /** @description Pricing currency as a 3-letter ISO 4217 code (e.g. AED). Optional; defaults to USD server-side. Not inherited from the search: a search created in one currency reads back in USD unless you pass currency on every read, so re-send the search's currency to keep prices in it. */
                currency?: string;
                /** @description Response language tag (e.g. en, ar). Optional; defaults to en server-side. Not inherited from the search – pass it on each read to keep results in that language. */
                locale?: string;
                /** @description Response projection. default (agent shape): the full itinerary with every fare and per-flight segments. detail: the richer UI view-model (per-segment amenities, seat metadata, provider brand). Defaults to default. */
                view?: "default" | "detail";
            };
            header?: never;
            path: {
                /** @description The trip id from a search-results snapshot, shaped {searchId}:{tripCode}. It resolves only together with the searchId it came from, and both expire with the search. */
                tripId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The full itinerary + all fares for the trip (agent default) or, with ?view=detail, the per-segment detail projection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Opaque trip id, shaped {searchId}:{tripCode}; read it back with GET /v1/flights/trips/{tripId}. */
                        tripId: string;
                        /**
                         * @description The single highest-priority featured label, best_value > cheapest > cheapest_direct. best_value ranks on the score of the trip's CHEAPEST fare, the same statistic sort=score_desc orders by, so on a score_desc read it lands on the first result. cheapest and cheapest_direct break a price tie by that same score, then by leg-1 departure – cheapest keeps the LATER departure, cheapest_direct the EARLIER one. Under sort=score_desc the two picks are also MOVED toward positions 2 and 3, matching wego.com. Those positions are targets, not guarantees: a pick already at or above its target stays put, and cheapest_direct lands at position 2 when the first result is itself at the cheapest price.
                         * @enum {string}
                         */
                        featured?: "best_value" | "cheapest" | "cheapest_direct";
                        /** @description Trip-level stop count, the max across legs. */
                        stops: number;
                        /** @description Total trip duration in minutes, summed across legs. */
                        durationMinutes: number;
                        /** @description The outbound leg. */
                        outbound: {
                            /** @description Departure airport IATA code. */
                            from: string;
                            /** @description Arrival airport IATA code. */
                            to: string;
                            /** @description Leg departure, ISO 8601 with offset. */
                            departsAt: string;
                            /** @description Leg arrival, ISO 8601 with offset. */
                            arrivesAt: string;
                            /** @description Total leg duration in minutes. */
                            durationMinutes: number;
                            /** @description Stops on this leg (0 is nonstop). */
                            stops: number;
                            /** @description Raw IATA airline codes on the leg (unchanged). See airlinesDetail for display names. */
                            airlines: string[];
                            /** @description Index-aligned display names for `airlines`, resolved from the search snapshot's airline dictionary – the same join the results cards use; the bare code is the fallback on a dictionary miss. Omitted when the leg carries no airline codes. Additive – raw `airlines` codes are unaffected. */
                            airlinesDetail?: {
                                /** @description IATA airline code (the operating/marketing carrier). */
                                code: string;
                                /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                name: string;
                            }[];
                            /** @description Carriers that fly a segment of this leg they do not market. airlines / airlinesDetail name the MARKETING carriers only, so on a leg sold by one airline every code here is a carrier absent from the ticket; on an interline leg sold by two, one of these may also market a different segment. Read this before telling a traveller who they fly – mileage accrual, lounge access and baggage rules follow the operating carrier. Distinct codes, folded from this leg's own segments; pair it with segments[] to see which flight each one operates. PRESENT ONLY WHEN A SEGMENT PROVES A CODESHARE: absent means none was proven on this leg, never a promise that the marketing carrier operates every segment. */
                            operatingAirlines?: {
                                /** @description IATA airline code (the operating/marketing carrier). */
                                code: string;
                                /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                name: string;
                            }[];
                            /** @description Distinct transport modes across this leg's segments, in segment order. Always present and never empty: an all-flight leg reads ["FLIGHT"], so one read of this field replaces folding segments[] yourself. Anything else means part of this leg is not a plane, and segments[] says which part. */
                            transportTypes: ("FLIGHT" | "TRAIN" | "BUS" | "OTHER")[];
                            /** @description Per-segment identity (marketing/operating carrier, flight number, times, transport mode); omitted when upstream carries no segments for the leg. Previously reachable only via ?view=detail. */
                            segments?: {
                                /** @description Departure airport IATA code. */
                                from: string;
                                /** @description Arrival airport IATA code. */
                                to: string;
                                /** @description Segment departure, ISO 8601 with offset. */
                                departsAt: string;
                                /** @description Segment arrival, ISO 8601 with offset. */
                                arrivesAt: string;
                                /** @description The carrier whose code is on the ticket (the marketing / flight-number airline). */
                                marketingCarrier: {
                                    /** @description IATA airline code (the operating/marketing carrier). */
                                    code: string;
                                    /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                    name: string;
                                };
                                /** @description The carrier that actually operates the flight – present ONLY on a codeshare, when it differs from the marketing carrier. */
                                operatingCarrier?: {
                                    /** @description IATA airline code (the operating/marketing carrier). */
                                    code: string;
                                    /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                    name: string;
                                };
                                /** @description The marketing flight designator, e.g. SQ12. */
                                flightNumber: string;
                                /**
                                 * @description How this segment travels. FLIGHT is a plane. TRAIN and BUS are surface segments sold under a flight number, which airlines do publish, for example the Etihad coach between Dubai Bus Station and Abu Dhabi. OTHER is a mode upstream states that this API does not model, and is never a flight. Absent upstream is published as FLIGHT, which is what every segment meant before this field existed.
                                 * @enum {string}
                                 */
                                transportType: "FLIGHT" | "TRAIN" | "BUS" | "OTHER";
                                /** @description Departure endpoint's display name, when upstream hydrates it on the segment, for example "Dubai Bus Station" beside the bare XNB. Absent rather than guessed when upstream carries no name. */
                                fromName?: string;
                                /** @description Arrival endpoint's display name, when upstream hydrates it on the segment. */
                                toName?: string;
                                /**
                                 * @description What kind of place the departure endpoint is, when upstream states it. Absent means unstated, never airport: read transportType, which is always present, to judge whether this segment is a flight.
                                 * @enum {string}
                                 */
                                fromStationType?: "airport" | "bus_station" | "train_station" | "other";
                                /**
                                 * @description What kind of place the arrival endpoint is, when upstream states it. Absent means unstated, never airport.
                                 * @enum {string}
                                 */
                                toStationType?: "airport" | "bus_station" | "train_station" | "other";
                            }[];
                        };
                        /** @description The return leg; present only on a round trip. */
                        return?: {
                            /** @description Departure airport IATA code. */
                            from: string;
                            /** @description Arrival airport IATA code. */
                            to: string;
                            /** @description Leg departure, ISO 8601 with offset. */
                            departsAt: string;
                            /** @description Leg arrival, ISO 8601 with offset. */
                            arrivesAt: string;
                            /** @description Total leg duration in minutes. */
                            durationMinutes: number;
                            /** @description Stops on this leg (0 is nonstop). */
                            stops: number;
                            /** @description Raw IATA airline codes on the leg (unchanged). See airlinesDetail for display names. */
                            airlines: string[];
                            /** @description Index-aligned display names for `airlines`, resolved from the search snapshot's airline dictionary – the same join the results cards use; the bare code is the fallback on a dictionary miss. Omitted when the leg carries no airline codes. Additive – raw `airlines` codes are unaffected. */
                            airlinesDetail?: {
                                /** @description IATA airline code (the operating/marketing carrier). */
                                code: string;
                                /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                name: string;
                            }[];
                            /** @description Carriers that fly a segment of this leg they do not market. airlines / airlinesDetail name the MARKETING carriers only, so on a leg sold by one airline every code here is a carrier absent from the ticket; on an interline leg sold by two, one of these may also market a different segment. Read this before telling a traveller who they fly – mileage accrual, lounge access and baggage rules follow the operating carrier. Distinct codes, folded from this leg's own segments; pair it with segments[] to see which flight each one operates. PRESENT ONLY WHEN A SEGMENT PROVES A CODESHARE: absent means none was proven on this leg, never a promise that the marketing carrier operates every segment. */
                            operatingAirlines?: {
                                /** @description IATA airline code (the operating/marketing carrier). */
                                code: string;
                                /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                name: string;
                            }[];
                            /** @description Distinct transport modes across this leg's segments, in segment order. Always present and never empty: an all-flight leg reads ["FLIGHT"], so one read of this field replaces folding segments[] yourself. Anything else means part of this leg is not a plane, and segments[] says which part. */
                            transportTypes: ("FLIGHT" | "TRAIN" | "BUS" | "OTHER")[];
                            /** @description Per-segment identity (marketing/operating carrier, flight number, times, transport mode); omitted when upstream carries no segments for the leg. Previously reachable only via ?view=detail. */
                            segments?: {
                                /** @description Departure airport IATA code. */
                                from: string;
                                /** @description Arrival airport IATA code. */
                                to: string;
                                /** @description Segment departure, ISO 8601 with offset. */
                                departsAt: string;
                                /** @description Segment arrival, ISO 8601 with offset. */
                                arrivesAt: string;
                                /** @description The carrier whose code is on the ticket (the marketing / flight-number airline). */
                                marketingCarrier: {
                                    /** @description IATA airline code (the operating/marketing carrier). */
                                    code: string;
                                    /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                    name: string;
                                };
                                /** @description The carrier that actually operates the flight – present ONLY on a codeshare, when it differs from the marketing carrier. */
                                operatingCarrier?: {
                                    /** @description IATA airline code (the operating/marketing carrier). */
                                    code: string;
                                    /** @description Airline display name from the search snapshot's airline dictionary; the bare code is the fallback on a dictionary miss. */
                                    name: string;
                                };
                                /** @description The marketing flight designator, e.g. SQ12. */
                                flightNumber: string;
                                /**
                                 * @description How this segment travels. FLIGHT is a plane. TRAIN and BUS are surface segments sold under a flight number, which airlines do publish, for example the Etihad coach between Dubai Bus Station and Abu Dhabi. OTHER is a mode upstream states that this API does not model, and is never a flight. Absent upstream is published as FLIGHT, which is what every segment meant before this field existed.
                                 * @enum {string}
                                 */
                                transportType: "FLIGHT" | "TRAIN" | "BUS" | "OTHER";
                                /** @description Departure endpoint's display name, when upstream hydrates it on the segment, for example "Dubai Bus Station" beside the bare XNB. Absent rather than guessed when upstream carries no name. */
                                fromName?: string;
                                /** @description Arrival endpoint's display name, when upstream hydrates it on the segment. */
                                toName?: string;
                                /**
                                 * @description What kind of place the departure endpoint is, when upstream states it. Absent means unstated, never airport: read transportType, which is always present, to judge whether this segment is a flight.
                                 * @enum {string}
                                 */
                                fromStationType?: "airport" | "bus_station" | "train_station" | "other";
                                /**
                                 * @description What kind of place the arrival endpoint is, when upstream states it. Absent means unstated, never airport.
                                 * @enum {string}
                                 */
                                toStationType?: "airport" | "bus_station" | "train_station" | "other";
                            }[];
                        };
                        /** @description Bookable fares for this trip, cheapest-first. */
                        fares: {
                            /**
                             * @description Fare source: wego (Book-on-Wego), airline (booked with the carrier) or partner (an OTA).
                             * @enum {string}
                             */
                            kind: "wego" | "airline" | "partner";
                            /** @description Opaque fare id; pass it to the fare-options and booking-link routes. */
                            fareId: string;
                            /** @description Booking provider code (the OTA or airline selling this fare). */
                            providerCode: string;
                            /** @description Booking provider display name. */
                            providerName: string;
                            /** @description Fare price. total/totalUsd are the whole-party amount, fee-inclusive, and are the authoritative figure for this fare. Search-time fares carry no per-passenger breakdown. */
                            price: {
                                /** @description Whole-party total (adults + children + infants) in the requested currency, including payment + booking fees. No separate tax breakdown at search time: the fare options read carries a tax figure, set by the cabin rather than by the individual fare option. */
                                total: number;
                                /** @description Whole-party total in USD (the cheapest-first sort key), including fees. */
                                totalUsd: number;
                                /** @description ISO 4217 currency of total. */
                                currency: string;
                                /**
                                 * @description total covers the whole party (adults + children + infants), not per-person.
                                 * @constant
                                 */
                                scope: "party";
                                /**
                                 * @description total includes payment + booking fees; there is no separate tax breakdown at search time.
                                 * @constant
                                 */
                                includesFees: true;
                            };
                            /** @description Whether this fare is refundable, as the provider states it. */
                            refundable: boolean;
                            /** @description Whether GET /v1/flights/fares/{fareId}/options can expand this fare into branded options. */
                            hasFareOptions: boolean;
                            /** @description Deep link that hands the booking off to the provider or wego.com checkout for this fare. */
                            handoffUrl: string;
                        }[];
                        /** @description What this read resolved currency and locale to, and how each was decided. */
                        metadata: {
                            /** @description The currency this read ASKED upstream for, and the one every price on it is meant to be in. Read it beside currencyCodeSource before you show a number: a price computed in the wrong currency renders as a perfectly normal price, with no error and no odd shape to notice, so the response states which one rather than leaving it to be inferred. Where the operation also publishes a top-level currencyCode, that field reports the currency the prices actually came back in; the two agree unless upstream declined to reprice. */
                            currencyCode: string;
                            /**
                             * @description How the API resolved currencyCode: explicit (the caller sent currency – including a value equal to the default) or default (USD, no currency sent). A default here is the one signal that the request never carried the currency you meant.
                             * @enum {string}
                             */
                            currencyCodeSource: "explicit" | "default";
                            /** @description The language tag this read asked upstream for – what any localized text on it was resolved in (room and board names, airline and airport names, review prose). */
                            locale: string;
                            /**
                             * @description How the API resolved locale: explicit (the caller sent locale – including a value equal to the default) or default (en, no locale sent). A default here explains text that came back in a language the caller did not ask for.
                             * @enum {string}
                             */
                            localeSource: "explicit" | "default";
                        };
                    } | {
                        /** @description Opaque trip id, shaped {searchId}:{tripCode}; read it back with GET /v1/flights/trips/{tripId}. */
                        tripId: string;
                        /** @description Trip-level stop count, the max across legs. */
                        stops: number;
                        /** @description Total trip duration in minutes, summed across legs. */
                        durationMinutes: number;
                        /** @description The trip's legs with per-segment detail, outbound first. */
                        legs: {
                            /**
                             * @description Which leg this is: depart or return.
                             * @enum {string}
                             */
                            direction: "depart" | "return";
                            /** @description Departure airport for this leg. */
                            from: {
                                /** @description Airport IATA code. */
                                code: string;
                                /** @description Airport display name from the snapshot's places. */
                                name: string;
                                /** @description City name, when the dictionary has it. */
                                city?: string;
                                /**
                                 * @description What kind of place this is, when upstream states it. Absent means unstated, never airport.
                                 * @enum {string}
                                 */
                                stationType?: "airport" | "bus_station" | "train_station" | "other";
                            };
                            /** @description Arrival airport for this leg. */
                            to: {
                                /** @description Airport IATA code. */
                                code: string;
                                /** @description Airport display name from the snapshot's places. */
                                name: string;
                                /** @description City name, when the dictionary has it. */
                                city?: string;
                                /**
                                 * @description What kind of place this is, when upstream states it. Absent means unstated, never airport.
                                 * @enum {string}
                                 */
                                stationType?: "airport" | "bus_station" | "train_station" | "other";
                            };
                            /** @description Leg departure, ISO 8601 with offset. */
                            departsAt: string;
                            /** @description Leg arrival, ISO 8601 with offset. */
                            arrivesAt: string;
                            /** @description Calendar days the arrival lands after departure (the +1 badge). */
                            arrivalDayOffset: number;
                            /** @description The leg spans a night. */
                            overnight: boolean;
                            /** @description Leg duration in minutes. */
                            durationMinutes: number;
                            /** @description Stops on this leg (0 is nonstop). */
                            stops: number;
                            /** @description Total layover across the leg's stops, minutes. */
                            layoverMinutes?: number;
                            /** @description The individual flights that make up this leg. */
                            segments: {
                                /** @description Departure airport for this segment. */
                                from: {
                                    /** @description Airport IATA code. */
                                    code: string;
                                    /** @description Airport display name from the snapshot's places. */
                                    name: string;
                                    /** @description City name, when the dictionary has it. */
                                    city?: string;
                                    /**
                                     * @description What kind of place this is, when upstream states it. Absent means unstated, never airport.
                                     * @enum {string}
                                     */
                                    stationType?: "airport" | "bus_station" | "train_station" | "other";
                                };
                                /** @description Arrival airport for this segment. */
                                to: {
                                    /** @description Airport IATA code. */
                                    code: string;
                                    /** @description Airport display name from the snapshot's places. */
                                    name: string;
                                    /** @description City name, when the dictionary has it. */
                                    city?: string;
                                    /**
                                     * @description What kind of place this is, when upstream states it. Absent means unstated, never airport.
                                     * @enum {string}
                                     */
                                    stationType?: "airport" | "bus_station" | "train_station" | "other";
                                };
                                /** @description Segment departure, ISO 8601 with offset. */
                                departsAt: string;
                                /** @description Segment arrival, ISO 8601 with offset. */
                                arrivesAt: string;
                                /** @description Segment duration in minutes. */
                                durationMinutes: number;
                                /** @description An airline resolved to code, name and logo. */
                                airline: {
                                    /** @description IATA airline code. */
                                    code: string;
                                    /** @description Airline display name. */
                                    name: string;
                                    /** @description Airline logo URL; may 404, fall back to the name. */
                                    logoUrl: string;
                                };
                                /** @description Present only when the operating carrier differs. */
                                operatedBy?: string;
                                /** @description Marketing flight designator, e.g. SQ12. */
                                flightNumber: string;
                                /** @description Aircraft type name, e.g. Boeing 777-300ER. On a surface segment this carries the equipment label ("Bus"); transportType is the typed form of the same fact. */
                                aircraft: string;
                                /**
                                 * @description How this segment travels. FLIGHT is a plane. TRAIN and BUS are surface segments sold under a flight number, which airlines do publish, for example the Etihad coach between Dubai Bus Station and Abu Dhabi. OTHER is a mode upstream states that this API does not model, and is never a flight. Absent upstream is published as FLIGHT, which is what every segment meant before this field existed.
                                 * @enum {string}
                                 */
                                transportType: "FLIGHT" | "TRAIN" | "BUS" | "OTHER";
                                /** @description Cabin class on this segment. */
                                cabin: string;
                                /** @description Cabin amenities on the segment, by kind; each present only when upstream reports it. */
                                amenities?: {
                                    /** @description One cabin amenity on a segment. */
                                    wifi?: {
                                        /** @description Human label for the amenity. */
                                        text: string;
                                        /** @description The amenity is present on the segment. */
                                        exists: boolean;
                                        /** @description The amenity is included, not sold as an extra. */
                                        free: boolean;
                                    };
                                    /** @description One cabin amenity on a segment. */
                                    power?: {
                                        /** @description Human label for the amenity. */
                                        text: string;
                                        /** @description The amenity is present on the segment. */
                                        exists: boolean;
                                        /** @description The amenity is included, not sold as an extra. */
                                        free: boolean;
                                    };
                                    /** @description One cabin amenity on a segment. */
                                    entertainment?: {
                                        /** @description Human label for the amenity. */
                                        text: string;
                                        /** @description The amenity is present on the segment. */
                                        exists: boolean;
                                        /** @description The amenity is included, not sold as an extra. */
                                        free: boolean;
                                    };
                                    /** @description One cabin amenity on a segment. */
                                    meal?: {
                                        /** @description Human label for the amenity. */
                                        text: string;
                                        /** @description The amenity is present on the segment. */
                                        exists: boolean;
                                        /** @description The amenity is included, not sold as an extra. */
                                        free: boolean;
                                    };
                                };
                                /** @description Seat pitch and layout for the segment, when reported. */
                                seat?: {
                                    /** @description Seat pitch, e.g. "76 cm seat pitch". */
                                    pitch?: string;
                                    /** @description Row layout, e.g. "3-3-3". */
                                    layout?: string;
                                };
                            }[];
                        }[];
                        /** @description Bookable fares for this trip, cheapest-first. */
                        fares: {
                            /**
                             * @description Fare source: wego (Book-on-Wego), airline (booked with the carrier) or partner (an OTA).
                             * @enum {string}
                             */
                            kind: "wego" | "airline" | "partner";
                            /** @description Opaque fare id; pass it to the fare-options and booking-link routes. */
                            fareId: string;
                            /** @description A booking provider resolved to code, name, logo and brand color. */
                            provider: {
                                /** @description Booking provider (OTA/airline) code. */
                                code: string;
                                /** @description Provider display name. */
                                name: string;
                                /** @description Synthesized provider logo URL; may 404 – fall back to name. */
                                logoUrl: string;
                                /** @description Provider brand color, when known. */
                                color?: string;
                            };
                            /** @description Fare price for the whole party, fee-inclusive. */
                            price: {
                                /** @description Whole-party total, including payment + booking fees. */
                                total: number;
                                /** @description Whole-party total in USD. */
                                totalUsd: number;
                                /** @description ISO 4217 currency of total. */
                                currency: string;
                                /** @description Upstream totals are fee-inclusive; no separate tax breakdown at search time. */
                                includesTaxesAndFees: boolean;
                            };
                            /** @description Baggage allowance for this fare, when the provider states it. */
                            baggage?: {
                                /** @description Cabin baggage allowance display string. */
                                cabin?: string;
                                /** @description Checked baggage allowance display string. */
                                checked?: string;
                            };
                            /** @description Whether this fare is refundable, as the provider states it. */
                            refundable: boolean;
                            /** @description Whether GET /v1/flights/fares/{fareId}/options can expand this fare into branded options. */
                            hasFareOptions: boolean;
                            /** @description Deep link to the provider or wego.com checkout for this fare. */
                            handoffUrl: string;
                        }[];
                        /** @description What this read resolved currency and locale to, and how each was decided. */
                        metadata: {
                            /** @description The currency this read ASKED upstream for, and the one every price on it is meant to be in. Read it beside currencyCodeSource before you show a number: a price computed in the wrong currency renders as a perfectly normal price, with no error and no odd shape to notice, so the response states which one rather than leaving it to be inferred. Where the operation also publishes a top-level currencyCode, that field reports the currency the prices actually came back in; the two agree unless upstream declined to reprice. */
                            currencyCode: string;
                            /**
                             * @description How the API resolved currencyCode: explicit (the caller sent currency – including a value equal to the default) or default (USD, no currency sent). A default here is the one signal that the request never carried the currency you meant.
                             * @enum {string}
                             */
                            currencyCodeSource: "explicit" | "default";
                            /** @description The language tag this read asked upstream for – what any localized text on it was resolved in (room and board names, airline and airport names, review prose). */
                            locale: string;
                            /**
                             * @description How the API resolved locale: explicit (the caller sent locale – including a value equal to the default) or default (en, no locale sent). A default here explains text that came back in a language the caller did not ask for.
                             * @enum {string}
                             */
                            localeSource: "explicit" | "default";
                        };
                    };
                };
            };
            /** @description Invalid request body/query/path parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown or expired trip. Ids are context-bound: a tripId resolves only with the searchId it came from, and retrying an expired one never recovers - create a new search and rethread. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream flights service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The flights service is temporarily unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getTripExperience: {
        parameters: {
            query?: {
                /** @description Optional cross-check. When supplied it must equal the tripId's first :-segment; a mismatch is rejected. */
                searchId?: string;
            };
            header?: never;
            path: {
                /** @description The trip from a flight-search result. Shaped {searchId}:{tripCode}. */
                tripId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The trip's per-leg signals. A witness field that is absent was not asserted; it is not a negative. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The trip these signals are for. */
                        tripId: string;
                        /** @description Per-leg comfort signals, in itinerary order (outbound first). */
                        legs: {
                            /** @description The upstream leg id, e.g. `SIN-BKK:TR638~3:0`. */
                            id: string;
                            /** @description Departure airport IATA code. */
                            departureAirportCode: string;
                            /** @description Arrival airport IATA code. */
                            arrivalAirportCode: string;
                            /** @description Stopovers on this leg – what makes an absent shortStopover readable. */
                            stopsCount: number;
                            /** @description Per-leg comfort signals. newAircraft and highlyRatedCarrier are positive-only witnesses: present only when upstream asserts them, absent otherwise; absent is never a negative. */
                            signals: {
                                /** @description The leg spans a night. */
                                overnight: boolean;
                                /** @description A stopover long enough to be a wait rather than a connection. */
                                longStopover: boolean;
                                /** @description Departs early enough to cost a night's sleep. */
                                earlyDeparture: boolean;
                                /** @description Arrives late enough to cost one. */
                                lateArrival: boolean;
                                /**
                                 * @description A connection tight enough to be a risk. Omitted on a leg with no stopover: upstream reports every nonstop leg as a short stopover, which carries no information.
                                 * @constant
                                 */
                                shortStopover?: true;
                                /**
                                 * @description Present only when asserted; absent means not asserted.
                                 * @constant
                                 */
                                newAircraft?: true;
                                /**
                                 * @description Present only when asserted; absent means not asserted.
                                 * @constant
                                 */
                                highlyRatedCarrier?: true;
                            };
                        }[];
                        /** @description Trip-level experience metadata. */
                        metadata: {
                            /** @description Legs on this trip: 1 one-way, 2 a return. */
                            legCount: number;
                        };
                    };
                };
            };
            /** @description Invalid request body/query/path parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown trip, or its search has expired. Search again and re-open the trip - retrying the same id never recovers. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream flights service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The flights service is temporarily unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFareOptions: {
        parameters: {
            query?: {
                /** @description Pricing currency as a 3-letter ISO 4217 code. */
                currency?: string;
                /** @description Response language tag. */
                locale?: string;
            };
            header?: never;
            path: {
                /** @description The Book-on-Wego fare id from a flight-search trip detail. */
                fareId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The fare options, ordered by leg then cheapest-first within a leg. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The fare id these options are for. */
                        fareId: string;
                        /** @description The currency the prices are quoted in – the same value as metadata.currencyCode, which carries currencyCodeSource beside it. Unlike the results read, this route quotes in the currency it asked for, so the two cannot disagree. */
                        currencyCode: string;
                        /** @description The whole-trip price for this fare, so no caller has to add per-leg options together. Absent when the upstream did not state one. */
                        price?: {
                            /** @description Whole-trip, whole-party total for the cheapest combination of options, as the upstream states it. Not computed here. */
                            total: number;
                            /** @description The same figure in USD. */
                            totalUsd?: number;
                            /** @description ISO 4217 currency of total. */
                            currency: string;
                            /**
                             * @description total covers the whole party (adults + children + infants), not per-person.
                             * @constant
                             */
                            scope: "party";
                        };
                        /** @description The legs the options are attributed to, in upstream leg order. Present only when every option carries a legId that matches one of them. */
                        legs?: {
                            /** @description The leg this group of options prices, as the upstream numbers it (1 = the first leg). */
                            legId: number;
                            /** @description Departure airport code of the leg. */
                            from?: string;
                            /** @description Arrival airport code of the leg. */
                            to?: string;
                            /** @description Local departure date-time of the leg. */
                            departsAt?: string;
                            /** @description Marketing airline codes on the leg. */
                            airlines?: string[];
                        }[];
                        /** @description The full fare option list – no filter, no pagination. Ordered by legId, then cheapest-first inside each leg, so the two legs of a split fare never interleave. */
                        options: {
                            /** @description The fare option id (a UUID); sent to wego.com as the booking link's branded_fare param. */
                            fareOptionId: string;
                            /** @description The marketing name, e.g. Economy Lite. */
                            name: string;
                            /** @description The price of one fare option (pass-through display values). Always whole-party for passengers; read covers for how much of the trip it pays for. */
                            price: {
                                /** @description Whole-party total for this fare option in the requested currency, including payment + booking fees. Unlike search-time fares, the fare options read carries a tax figure upstream, surfaced as the sibling totalTaxAmount when present. */
                                total: number;
                                /** @description Whole-party total in USD. The price key options are sorted on WITHIN a leg; the list itself is ordered by leg first. */
                                totalUsd: number;
                                /** @description ISO 4217 currency of total. */
                                currency: string;
                                /** @description Whole-party tax for this option, in the same currency as total. Taxes are set by the cabin, not by the fare option, so every fare option in the same cabin carries the same figure while their totals differ. Forwarded when the upstream provides it; absent otherwise. */
                                totalTaxAmount?: number;
                                /** @description Per-passenger-type split of this option's total: one entry per type present in the party, each with its own head count. The party totals sum to total. Absent when the upstream priced the option without a passenger breakdown. */
                                passengers?: {
                                    /**
                                     * @description The passenger type this entry prices.
                                     * @enum {string}
                                     */
                                    type: "adult" | "child" | "infant";
                                    /** @description How many passengers of this type the party carries. */
                                    count: number;
                                    /** @description What a single passenger of this type pays. */
                                    perPerson: {
                                        /** @description Base fare for one passenger of this type. */
                                        fare: number;
                                        /** @description Tax for one passenger of this type. */
                                        tax: number;
                                        /** @description What one passenger of this type pays, fare + tax. */
                                        total: number;
                                    };
                                    /** @description perPerson times count, taken from the upstream's own party-level figure when it states one, so it can differ from the exact product in the last decimal place. */
                                    party: {
                                        /** @description Base fare for every passenger of this type. */
                                        fare: number;
                                        /** @description Tax for every passenger of this type. */
                                        tax: number;
                                        /** @description What every passenger of this type pays together. */
                                        total: number;
                                    };
                                }[];
                                /**
                                 * @description How much of the TRIP this total covers: leg = this option's own leg only, so a multi-leg trip needs one option per leg and their sum is the trip price; trip = the whole journey. Always whole-party either way. A positive witness – absent means the upstream did not let us attribute it, never that the total is the whole trip.
                                 * @enum {string}
                                 */
                                covers?: "leg" | "trip";
                            };
                            /** @description Whether this option is refundable. */
                            refundable: boolean;
                            /** @description Whether this option allows a date or flight change. */
                            exchangeable: boolean;
                            /** @description Baggage allowance display strings for one fare option. */
                            baggage: {
                                /** @description Cabin baggage allowance display string. */
                                cabin?: string;
                                /** @description Checked baggage allowance display string. */
                                checked?: string;
                            };
                            /** @description Always both change and cancel, in that order. */
                            penalties: {
                                /**
                                 * @description The action the penalty governs.
                                 * @enum {string}
                                 */
                                type: "change" | "cancel";
                                /**
                                 * @description free (allowed, no charge), fee (allowed, priced), or not_permitted.
                                 * @enum {string}
                                 */
                                policy: "free" | "fee" | "not_permitted";
                                /** @description Fee amount, present only when policy is fee. */
                                amount?: number;
                                /** @description ISO 4217 currency for amount, present only when policy is fee. */
                                currency?: string;
                            }[];
                            /** @description The airline's terms and conditions links for this option, in the order the carrier lists them. Absent when the carrier publishes its rules as text rather than links, or when the terms read was unavailable - never an empty array. These are the carrier's own pages, not a machine-readable rulebook: refundability, exchangeability, baggage and the change/cancel penalties are the fields on this option, and are what an agent should reason over. */
                            termsUrls?: string[];
                            /** @description The leg this option prices, matching a legs[] entry. Present when the upstream attributes it; absent when it does not. */
                            legId?: number;
                        }[];
                        /** @description What this read resolved currency and locale to, and how each was decided. */
                        metadata: {
                            /** @description The currency this read ASKED upstream for, and the one every price on it is meant to be in. Read it beside currencyCodeSource before you show a number: a price computed in the wrong currency renders as a perfectly normal price, with no error and no odd shape to notice, so the response states which one rather than leaving it to be inferred. Where the operation also publishes a top-level currencyCode, that field reports the currency the prices actually came back in; the two agree unless upstream declined to reprice. */
                            currencyCode: string;
                            /**
                             * @description How the API resolved currencyCode: explicit (the caller sent currency – including a value equal to the default) or default (USD, no currency sent). A default here is the one signal that the request never carried the currency you meant.
                             * @enum {string}
                             */
                            currencyCodeSource: "explicit" | "default";
                            /** @description The language tag this read asked upstream for – what any localized text on it was resolved in (room and board names, airline and airport names, review prose). */
                            locale: string;
                            /**
                             * @description How the API resolved locale: explicit (the caller sent locale – including a value equal to the default) or default (en, no locale sent). A default here explains text that came back in a language the caller did not ask for.
                             * @enum {string}
                             */
                            localeSource: "explicit" | "default";
                        };
                    };
                };
            };
            /** @description Invalid request query/path parameters, or the fares service rejected the fareId or currency (`validation_failed`; the `detail` names the recovery). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The fare was not found or its search has expired. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream flights service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The flights service is temporarily unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFareBookingLink: {
        parameters: {
            query: {
                /** @description The trip the fare belongs to, from a flight-search result. Shaped {searchId}:{tripCode}. */
                tripId: string;
                /** @description Optional cross-check. When supplied it must equal the tripId's first :-segment; a mismatch is rejected. */
                searchId?: string;
                /** @description The fare option(s) to pre-select, from GET /v1/flights/fares/{fareId}/options. Required: without it the booking page has no fare to open and dead-ends. When that read reported price.covers=leg, pass ONE id per trip leg as a comma-separated list, in any order: a single id then prices only its own leg while the page still presents the whole round trip. A whole-trip fare (price.covers=trip) takes exactly one id. At most 8, and no id twice. */
                fareOptionId: string;
                /** @description Origin airport or city code, as sent to the flight search. */
                from: string;
                /** @description Destination airport or city code, as sent to the flight search. */
                to: string;
                /** @description Whether `from` is a city code rather than an airport code. */
                fromCity?: boolean | ("0" | "1" | "true" | "false");
                /** @description Whether `to` is a city code rather than an airport code. */
                toCity?: boolean | ("0" | "1" | "true" | "false");
                /** @description Outbound departure date, YYYY-MM-DD, as sent to the flight search. */
                fromDate: string;
                /** @description Return date, YYYY-MM-DD. Omit for a one-way handoff. */
                toDate?: string;
                /** @description Cabin class, as sent to the flight search. */
                cabin?: "economy" | "premium_economy" | "business" | "first";
                /** @description Adult passengers (1-9). */
                adults?: number;
                /** @description Child passengers (0-8). */
                children?: number;
                /** @description Infant passengers (0-8). Must not exceed adults. */
                infants?: number;
                /** @description Wego market (point of sale) as a 2-letter code, e.g. AE. Optional: if omitted the API defaults to US. A client that knows the user's market (the wego CLI derives it from the id_token) passes it as an explicit siteCode. */
                siteCode?: string;
                /** @description Pricing currency as a 3-letter ISO 4217 code (e.g. AED). Optional: when omitted the built URL carries NO currency parameter – it is not defaulted to USD, so wego.com shows the market's own default. Pass it to pin the handoff to a currency. */
                currency?: string;
                /** @description Response language tag for the wego.com page (e.g. en, ar). Defaults to en. */
                locale?: string;
            };
            header?: never;
            path: {
                /** @description The Book-on-Wego fare id from a flight-search trip detail. */
                fareId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The booking handoff URL. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A wego.com booking deep-link with the chosen fare pre-selected. */
                        bookingUrl: string;
                        /**
                         * @description Always true: this link is bound to a live search and stops working with it, in about five to seven minutes. To send someone a link that lasts, use GET /v1/flights/search-link.
                         * @constant
                         */
                        expires: true;
                    };
                };
            };
            /** @description Invalid fare id or query parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFlightSearchLink: {
        parameters: {
            query: {
                /** @description Origin airport or city code, as sent to the flight search. */
                from: string;
                /** @description Destination airport or city code, as sent to the flight search. */
                to: string;
                /** @description Whether `from` is a city code rather than an airport code. */
                fromCity?: boolean | ("0" | "1" | "true" | "false");
                /** @description Whether `to` is a city code rather than an airport code. */
                toCity?: boolean | ("0" | "1" | "true" | "false");
                /** @description Outbound departure date, YYYY-MM-DD, as sent to the flight search. */
                fromDate: string;
                /** @description Return date, YYYY-MM-DD. Omit for a one-way handoff. */
                toDate?: string;
                /** @description Cabin class, as sent to the flight search. */
                cabin?: "economy" | "premium_economy" | "business" | "first";
                /** @description Adult passengers (1-9). */
                adults?: number;
                /** @description Child passengers (0-8). */
                children?: number;
                /** @description Infant passengers (0-8). Must not exceed adults. */
                infants?: number;
                /** @description Wego market (point of sale) as a 2-letter code, e.g. AE. Optional: if omitted the API defaults to US. A client that knows the user's market (the wego CLI derives it from the id_token) passes it as an explicit siteCode. */
                siteCode?: string;
                /** @description Pricing currency as a 3-letter ISO 4217 code (e.g. AED). Optional: when omitted the built URL carries NO currency parameter – it is not defaulted to USD, so wego.com shows the market's own default. Pass it to pin the handoff to a currency. */
                currency?: string;
                /** @description Response language tag for the wego.com page (e.g. en, ar). Defaults to en. */
                locale?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The durable wego.com search URL. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A wego.com flight-search URL for this route, dates, cabin and passengers. Opening it runs the search live. */
                        searchUrl: string;
                        /**
                         * @description Always false: the URL carries no search-scoped id, so it keeps working. The prices behind it are whatever a live search returns when it is opened.
                         * @constant
                         */
                        expires: false;
                    };
                };
            };
            /** @description Invalid query parameters. fromDate must be a real calendar date, not in the past, and within 365 days; toDate must be a real date on or after it. A durable link cannot carry a date no live search can represent. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createHotelSearch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description City code to search. One destination only, see oneOf.
                     * @example DXB
                     */
                    cityCode?: string;
                    /** @description Search a single hotel by id. One destination only, see oneOf. */
                    hotelId?: number;
                    /** @description Latitude. Must be paired with lng. */
                    lat?: number;
                    /** @description Longitude. Must be paired with lat. */
                    lng?: number;
                    /**
                     * @description Search radius in km around lat/lng.
                     * @default 10
                     */
                    radius?: number;
                    /** @description Check-in date, YYYY-MM-DD. Not in the past. */
                    checkIn: string;
                    /** @description Check-out date, YYYY-MM-DD. Must be after checkIn. */
                    checkOut: string;
                    /**
                     * @description Adults across the search (1-9). Defaults to 2, since a room sleeps two. Note the flight search defaults adults to 1.
                     * @default 2
                     */
                    adults?: number;
                    /**
                     * @description Children across the search (0-8). Defaults to 0.
                     * @default 0
                     */
                    children?: number;
                    /**
                     * @description Rooms to price (1-4). Defaults to 1; cannot exceed adults.
                     * @default 1
                     */
                    rooms?: number;
                    /** @description Per-child ages (integers 0–17). When provided, the count must equal `children`. When omitted, each child is priced at age 8 (the documented fallback). */
                    childrenAges?: number[];
                    /**
                     * @description Pricing currency as a 3-letter ISO 4217 code. Defaults to USD.
                     * @default USD
                     */
                    currency?: string;
                    /**
                     * @description Response language tag (e.g. en, ar). Defaults to en.
                     * @default en
                     */
                    locale?: string;
                    /** @description Wego market (point of sale) as a 2-letter code, e.g. AE. Optional: if omitted the API defaults to US. A client that knows the user's market (the wego CLI derives it from the id_token) passes it as an explicit siteCode. */
                    siteCode?: string;
                } & (unknown | unknown | unknown);
            };
        };
        responses: {
            /** @description Search created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Opaque id for the created search. */
                        searchId: string;
                        /** @description The occupancy priced upstream for this search (ages resolved, incl. fallback). */
                        occupancy: {
                            /** @description Adults priced upstream for this search. */
                            adults: number;
                            /** @description Resolved per-child ages actually sent upstream (age-8 fallback when omitted). */
                            childrenAges: number[];
                            /** @description Rooms priced upstream for this search. */
                            rooms: number;
                        };
                        /** @description The site code (Wego market) the search was created for. */
                        siteCode: string;
                        /**
                         * @description How the API resolved siteCode: explicit (caller-supplied – including a market a client derived and passed) or default (US, no site supplied).
                         * @enum {string}
                         */
                        siteCodeSource: "explicit" | "default";
                    };
                };
            };
            /** @description Invalid request parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown hotel. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream hotels service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The hotels service is unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHotelSearchResults: {
        parameters: {
            query?: {
                /** @description Page number, 1-based (max 100). Defaults to 1. */
                page?: number;
                /** @description Results per page (1-50). Defaults to 10. */
                pageSize?: number;
                /** @description Sort order. relevance (default) is the metasearch ranking; price_asc / price_desc by cheapest per-night rate; star_desc by star; review_score_desc by guest score; guest_rating_desc by the ?guest-type= cohort's own score, which requires that param (a hotel upstream did not score for the cohort sorts last, never zero-filled); distance_asc by distance to the city's place-record coordinate (see distanceToCityCentre). With ?refundable=true the price sorts key off the cheapest refundable rate. */
                sort?: "relevance" | "price_asc" | "price_desc" | "star_desc" | "review_score_desc" | "guest_rating_desc" | "distance_asc";
                /** @description Pricing currency as a 3-letter ISO 4217 code (e.g. AED). Defaults to USD. */
                currency?: string;
                /** @description Response language tag (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Keep hotels with at least this star rating (1-5). */
                "min-star"?: number;
                /** @description Keep hotels with at most this star rating (1-5). */
                "max-star"?: number;
                /** @description Keep hotels whose ALL-GUESTS review score is at least this (0-10). This is the everybody-rated-it-well question; for a named guest cohort use ?guest-type= with ?min-guest-rating=, which is a different number on most hotels. */
                "min-review-score"?: number;
                /** @description The guest cohort ?min-guest-rating= and sort=guest_rating_desc judge a hotel by: business, couple, family or solo. Read the vocabulary and this snapshot's per-cohort hotel counts from metadata.filterOptions.guestTypes. Must be sent with ?min-guest-rating= or sort=guest_rating_desc, and both of those require it - a cohort with nothing to apply it to is rejected rather than silently ignored. Spelled differently from the /reviews ?guest-type= vocabulary (family here, family_with_children there) because the two upstreams segment guests differently; business exists only here and extended_group only there. */
                "guest-type"?: "business" | "couple" | "family" | "solo";
                /** @description Keep hotels the ?guest-type= cohort rates at least this (0-10). Requires ?guest-type=. Judged on that cohort's own score, not the all-guests one: on a settled 420-hotel snapshot, of the 299 hotels scored for both, 58% had a family score at least 3 points from their overall one. A hotel upstream did not score for the cohort is DROPPED, and that absence means too little cohort data rather than a low score - upstream publishes no thin cohort rows, so a cohort score it does publish rests on more reviews than the all-guests figure sometimes does. */
                "min-guest-rating"?: number;
                /** @description Minimum price (inclusive), in the response currency. Bounds the all-in nightly figure: amountPerNight plus every per-night charge the card publishes beside it, localTaxPerNight and taxAmountPerNight where present. That figure covers every room in the search, so multiply a per-room budget by the room count in stay.occupancy.rooms. Read metadata.filterOptions.priceRange for the bounds this snapshot spans. With ?refundable=true it bounds the cheapest refundable rate. */
                "min-price"?: number;
                /** @description Maximum price (inclusive), in the response currency. Bounds the all-in nightly figure: amountPerNight plus every per-night charge the card publishes beside it, localTaxPerNight and taxAmountPerNight where present. That figure covers every room in the search, so multiply a per-room budget by the room count in stay.occupancy.rooms. Read metadata.filterOptions.priceRange for the bounds this snapshot spans. With ?refundable=true it bounds the cheapest refundable rate. */
                "max-price"?: number;
                /** @description Keep only hotels with a witnessed refundable Book-on-Wego rate, so a 'cheapest refundable' answer needs no per-hotel /rates calls. Exactly equivalent to ?rate-types=free_cancellation, and combines with it: this is the one rate type that has its own param. This is an UNDER-approximation: the results envelope is a rate sample, so a true keeps hotels with a seen refundable rate and a hotel's absence is not authoritative – only GET /v1/hotels/{hotelId}/rates can prove a hotel has no refundable rate. Accepts true or false. */
                refundable?: "0" | "1" | "true" | "false";
                /** @description Keep hotels with a witnessed Book-on-Wego rate carrying ALL listed rate types (AND across terms; repeat or comma-separate), so 'only rooms with breakfast' needs no per-hotel /rates calls. Read the vocabulary from metadata.filterOptions.rateTypes (e.g. breakfast_included, free_cancellation) – unlike every other list filter these are matched EXACTLY (case-insensitively), not as substrings, because they are stable upstream codes rather than localized display names. Several terms mean ONE rate carrying all of them, and while any rate-type filter is active the card price, the price bounds, the price sorts and the cheapest badge all key off that matching rate. Like refundable, an UNDER-approximation: the results envelope is a rate sample, so a hotel's absence is not proof it lacks the type – only GET /v1/hotels/{hotelId}/rates can prove that. */
                "rate-types"?: string[];
                /** @description Keep only hotels whose card carries a price.deal, mirroring the 'today's deals' filter on wego.com. Judged on the very price object the card publishes, so the kept hotels and the deals shown always agree – with ?refundable=true that means the refundable rate must be the discounted one. Like refundable, this is an UNDER-approximation: the results envelope is a rate sample that grows while searchComplete is false, so a hotel's absence is not proof it has no discount. Accepts true or false. */
                "deals-only"?: "0" | "1" | "true" | "false";
                /** @description Keep hotels offering ALL listed amenities (AND across terms; repeat or comma-separate). Each term is matched case-insensitively as a substring against the name field in metadata.filterOptions.amenities – pick terms from there (e.g. Fitness Centre), not a guessed synonym (gym). One term can span several values (Pool also matches Indoor Pool). */
                amenities?: string[];
                /** @description Keep hotels whose property type matches ANY listed term (OR; repeat or comma-separate). Matched case-insensitively as a substring against the name field in metadata.filterOptions.propertyTypes – pick from there rather than guessing. */
                "property-types"?: string[];
                /** @description Keep hotels whose brand matches ANY listed term (OR; repeat or comma-separate). Matched case-insensitively as a substring against the name field in metadata.filterOptions.brands – pick from there rather than guessing. Names parent companies as well as individual brands, and a term matches an entry name rather than a corporate relationship, so a group filed under several sibling brands needs each of those names listed. */
                brands?: string[];
                /** @description Keep hotels whose chain matches ANY listed term (OR; repeat or comma-separate). Matched case-insensitively as a substring against the name field in metadata.filterOptions.chains – pick from there rather than guessing. Most hotels carry no chain and some entries name a loyalty programme, so a hotel group may be reachable only through brands, or split across both vocabularies. */
                chains?: string[];
                /** @description Keep hotels whose district matches ANY listed term (OR; repeat or comma-separate). Matched case-insensitively as a substring against the name field in metadata.filterOptions.districts – pick from there rather than guessing. */
                districts?: string[];
                /** @description Response projection. `card` is the only value: the lean results-list projection (price summary, refundability witness, star/review, location names). The former `default` projection was removed in issue #1308 – read GET /v1/hotels/{hotelId} for a hotel's amenities, images and address. */
                view?: "card";
            };
            header?: never;
            path: {
                /** @description The opaque searchId returned by createHotelSearch. Ids expire; a 404 means the search is unknown or gone – create a new one. */
                searchId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ranked hotels, as lean list cards. Amenities, the full image list, the address and brand/chain are not on a card – read the hotel for the one row you picked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The id of the search this snapshot belongs to. */
                        searchId: string;
                        /** @description Currency the prices in this snapshot are quoted in. */
                        currencyCode: string;
                        /** @description Upstream aggregation flag. true is authoritative/terminal; conclude NO BOOK-ON-WEGO BOOKABLE INVENTORY only when true AND metadata.totalBeforeFilters === 0 – never that no hotel exists, since only Book-on-Wego inventory was requested. A zero totalCandidates on its own means only that this read's filters matched nothing, and an empty page with totalCandidates > 0 is pagination. false is inconclusive, so watch metadata.snapshotCandidateCount convergence to stop sooner. */
                        searchComplete: boolean;
                        /** @description What upstream priced: the dates and occupancy every price on this read covers. Present when upstream states them. */
                        stay?: {
                            /** @description Check-in date priced upstream, YYYY-MM-DD. */
                            checkIn: string;
                            /** @description Check-out date priced upstream, YYYY-MM-DD. */
                            checkOut: string;
                            /** @description Nights between checkIn and checkOut. price.total covers this many nights of price.amountPerNight. */
                            nights: number;
                            /** @description The occupancy priced upstream for this search (ages resolved, incl. fallback). */
                            occupancy: {
                                /** @description Adults priced upstream for this search. */
                                adults: number;
                                /** @description Resolved per-child ages actually sent upstream (age-8 fallback when omitted). */
                                childrenAges: number[];
                                /** @description Rooms priced upstream for this search. */
                                rooms: number;
                            };
                        };
                        /** @description Pagination, the snapshot's filter vocabulary, the settle counters for this read, and what it resolved currency and locale to. */
                        metadata: {
                            /** @description 1-based page number of this snapshot. */
                            page: number;
                            /** @description Hotels requested per page. */
                            pageSize: number;
                            /** @description Hotels on this page. The page only – judge a filter on totalCandidates. */
                            resultCount: number;
                            /** @description Hotels matching this read's filters across the snapshot – the count that judges a filter, not the page. A filter that matched nothing is totalCandidates 0 with totalBeforeFilters above 0. */
                            totalCandidates: number;
                            /** @description Hotels that survived the Book-on-Wego join, before this read's filters ran. A filter that matched nothing is totalCandidates === 0 with totalBeforeFilters > 0. Zero means no Book-on-Wego-bookable inventory surfaced for these dates – it is NOT proof that no hotel exists, since the join runs over a sampled rate list. Equal to totalCandidates on an unfiltered read. */
                            totalBeforeFilters: number;
                            /** @description The filterable vocabulary of the hotels in this snapshot, ordered by count, over the same population as totalBeforeFilters. The amenities / property-types / brands / chains / districts query params take an entry's name field VERBATIM (matched case-insensitively as a substring), so pick from here rather than guessing a synonym. A term listed here matches AT LEAST its count on an unfiltered read; the count is a lower bound, since one term can span several values (Pool also matches Indoor Pool). rateTypes and guestTypes are the exceptions: their names are stable codes, matched exactly rather than as substrings, so their counts are precise rather than a lower bound. guestTypes counts a smaller population than the rest for a different reason - it counts only the hotels upstream scored for that cohort, and upstream publishes no thin cohort rows, so a hotel absent from a cohort has too little data for it rather than a poor rating. Still growing while searchComplete is false. priceRange does the same job for the numeric bounds: it states the span min-price / max-price are measured on, so read it before choosing either. */
                            filterOptions: {
                                /** @description Amenity terms present in this snapshot, by count. */
                                amenities: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description Property-type terms present in this snapshot, by count. */
                                propertyTypes: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description Brand terms present in this snapshot, by count. */
                                brands: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description Chain terms present in this snapshot, by count. */
                                chains: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description District terms present in this snapshot, by count. */
                                districts: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description Rate types witnessed on this snapshot's Book-on-Wego rates, by hotel count – the vocabulary ?rate-types= accepts (e.g. breakfast_included, free_cancellation). Unlike every other vocabulary here the name is a stable upstream CODE, not a localized display name, so it is matched EXACTLY rather than as a substring and reads the same under any locale. Each count is the number of hotels with at least one rate carrying that type. */
                                rateTypes: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description Guest cohorts this snapshot carries ratings for, by hotel count – the vocabulary ?guest-type= accepts (business, couple, family, solo). Like rateTypes the name is a stable CODE matched exactly, not a localized display name, so the counts are precise. Each count is the number of hotels upstream scored for that cohort, which is FEWER than the hotels carrying an all-guests score: upstream publishes no thin cohort rows, so a hotel missing from a cohort's count has too little data for it rather than a poor rating. Spelled differently from the /reviews ?guest-type= vocabulary (family here, family_with_children there) because the two upstreams segment guests differently. */
                                guestTypes: {
                                    /** @description The term the matching filter query param accepts, verbatim. */
                                    name: string;
                                    /** @description Hotels carrying this value on an unfiltered read. For the substring-matched vocabularies (amenities, propertyTypes, brands, chains, districts) it is a LOWER BOUND, since one term can span several values. For the code-keyed ones (rateTypes, guestTypes) it is EXACT, because those terms are matched exactly rather than as substrings - and a guestTypes count spans only the hotels upstream scored for that cohort, which is fewer than carry an all-guests score. */
                                    count: number;
                                }[];
                                /** @description The span the min-price / max-price bounds compare against, on their own basis: amountPerNight plus every per-night charge the card publishes beside it, localTaxPerNight and taxAmountPerNight where present, covering every room in the search. Both ends are attainable, since the bounds are inclusive, so min-price at min and max-price at max each keep the whole snapshot, and a bound outside the span returns nothing. Read over each hotel's headline price, so with ?refundable=true the bounds move to lowestRefundablePrice and can reach past max. Folded over the same population as totalBeforeFilters, so it does not narrow as other filters bite, and it still moves while searchComplete is false. Absent when the snapshot holds no hotel. */
                                priceRange?: {
                                    /** @description The cheapest hotel's all-in nightly figure, in the response currency. */
                                    min: number;
                                    /** @description The dearest hotel's all-in nightly figure, in the response currency. */
                                    max: number;
                                };
                            };
                            /** @description Another page of hotels follows. */
                            hasMore: boolean;
                            /** @description Upstream aggregation counter – the practical early convergence signal. Two spaced (not back-to-back), equal, non-zero reads ≈ settled enough to render; it stabilizes well before searchComplete flips, so use it to stop polling sooner. A heuristic, not proof of completion (searchComplete:true is that). Not the same as totalCandidates (the post-Book-on-Wego-join hotel count). */
                            snapshotCandidateCount: number;
                            /** @description When this search was created (ISO 8601) – the freshness anchor for these prices. A search older than about 10 minutes may answer 404 as expired. Absent when the search service omits it. */
                            createdAt?: string;
                            /** @description The currency this read ASKED upstream for, and the one every price on it is meant to be in. Read it beside currencyCodeSource before you show a number: a price computed in the wrong currency renders as a perfectly normal price, with no error and no odd shape to notice, so the response states which one rather than leaving it to be inferred. Where the operation also publishes a top-level currencyCode, that field reports the currency the prices actually came back in; the two agree unless upstream declined to reprice. */
                            currencyCode: string;
                            /**
                             * @description How the API resolved currencyCode: explicit (the caller sent currency – including a value equal to the default) or default (USD, no currency sent). A default here is the one signal that the request never carried the currency you meant.
                             * @enum {string}
                             */
                            currencyCodeSource: "explicit" | "default";
                            /** @description The language tag this read asked upstream for – what any localized text on it was resolved in (room and board names, airline and airport names, review prose). */
                            locale: string;
                            /**
                             * @description How the API resolved locale: explicit (the caller sent locale – including a value equal to the default) or default (en, no locale sent). A default here explains text that came back in a language the caller did not ask for.
                             * @enum {string}
                             */
                            localeSource: "explicit" | "default";
                        };
                        /** @description The requested page of ranked hotels, as list cards. */
                        results: {
                            /** @description The hotel's numeric id; read its detail with GET /v1/hotels/{hotelId}. */
                            hotelId: number;
                            /** @description Hotel display name. */
                            name: string;
                            /** @description The hotel's page on wego.com. It is not tied to a search, so it keeps working after this search expires. Give it to a traveller who wants to look at the hotel, and use it in anything that is saved or sent on. It opens with no dates set. */
                            pageUrl: string;
                            /** @description Star rating (1-5), when classified. */
                            star?: number;
                            /** @description Aggregate guest review score and count. */
                            review?: {
                                /** @description Aggregate guest review score (0-10). */
                                score: number;
                                /** @description Number of guest reviews behind the score. */
                                count: number;
                            };
                            /** @description Guest review score and count per cohort, on the same 0-10 scale as review (which is the all-guests figure). These are the exact values ?guest-type= accepts and the same vocabulary metadata.filterOptions.guestTypes counts. A cohort is present only when upstream scored it, and an ABSENT cohort means too little data for that cohort, never a low score - upstream publishes no thin cohort rows. Read these to explain a pick as well as make one: a hotel rated 8.5 overall and 7.6 by families is a different recommendation than one rated 8.5 by both. Omitted when no cohort was scored. */
                            reviewsByGuestType?: {
                                /** @description How business travellers rate this hotel. */
                                business?: {
                                    /** @description Guest review score for this cohort (0-10). */
                                    score: number;
                                    /** @description Number of that cohort's reviews behind the score. */
                                    count: number;
                                };
                                /** @description How couples rate this hotel. */
                                couple?: {
                                    /** @description Guest review score for this cohort (0-10). */
                                    score: number;
                                    /** @description Number of that cohort's reviews behind the score. */
                                    count: number;
                                };
                                /** @description How families rate this hotel. */
                                family?: {
                                    /** @description Guest review score for this cohort (0-10). */
                                    score: number;
                                    /** @description Number of that cohort's reviews behind the score. */
                                    count: number;
                                };
                                /** @description How solo travellers rate this hotel. */
                                solo?: {
                                    /** @description Guest review score for this cohort (0-10). */
                                    score: number;
                                    /** @description Number of that cohort's reviews behind the score. */
                                    count: number;
                                };
                            };
                            /** @description A card's per-night and stay price. Every amount covers the whole booking, all rooms in the search, so quote these figures as they stand. Upstream rounds per booking, so total is the exact stay figure and amountPerNight is one night of it. Any per-night figure published beside amountPerNight is charged ON TOP of it: add localTaxPerNight, and taxAmountPerNight when it appears, to reach what a guest pays and what the price sorts and bounds rank on. */
                            price: {
                                /**
                                 * @description What every amount here covers: the whole booking, all rooms in the search.
                                 * @constant
                                 */
                                scope: "booking";
                                /** @description One night of the whole booking, in the response currency, covering every room. Excludes localTaxPerNight, and taxAmountPerNight when that field appears. Rounded to a whole currency unit upstream; total is the exact stay figure. */
                                amountPerNight: number;
                                /** @description Per-night tax charged on top of amountPerNight, in the response currency. Present only when the amount excludes it; absent means amountPerNight already covers any such tax, which is the usual case. Add it the same way as localTaxPerNight. */
                                taxAmountPerNight?: number;
                                /** @description Per-night local tax (city/tourism/municipality), charged on top of amountPerNight. wego.com adds it to the price it displays. Present when upstream reports the tax, where 0 means none charged. Absent when upstream reports it as unknown. */
                                localTaxPerNight?: number;
                                /** @description Stay total of local tax as reported upstream, which rounds the nightly figure. Present when upstream reports the tax. Absent when upstream reports it as unknown. */
                                totalLocalTax?: number;
                                /** @description Stay total in the response currency. Excludes totalLocalTax, mirroring amountPerNight. */
                                total?: number;
                                /** @description The discount advertised on this rate, absent when the rate carries none. Describes THIS price object, so with ?refundable=true it describes the refundable rate the card switched to. */
                                deal?: {
                                    /** @description The offer's own tag, e.g. 'Best Deal'. Its presence also says where wasPerNight came from: see that field. */
                                    label?: string;
                                    /** @description The offer's discount as a whole percent. A tagged offer's percent wins over a usual-price one, matching the site's precedence, and the two often differ. wego.com renders a percentage only for an UNTAGGED offer; a tagged one it shows as its label plus a crossed-out price, so do not attribute this figure to what the page displays. Always describes the same offer as wasPerNight, so the pair never disagree. */
                                    percentOff: number;
                                    /** @description Pre-discount per-night price, on amountPerNight's basis so the two subtract cleanly. When label is present this is COMPUTED back from the offer's unrounded discount, since a tagged offer carries no pre-discount price of its own and wego.com renders the same computed figure; quote it as approximate, and expect it to differ slightly from a figure you derive using the rounded percentOff. When label is absent it is the quoted pre-discount price itself. */
                                    wasPerNight?: number;
                                    /** @description Pre-discount stay total, on total's basis. Computed or quoted on the same rule as wasPerNight. */
                                    wasTotal?: number;
                                    /** @description Promo code the traveller enters at checkout, when the offer carries one. Most live offers are provider discounts with no code. */
                                    promoCode?: string;
                                };
                                /** @description Stay total in USD, the cross-currency ranking key. */
                                totalUsd: number;
                                /** @description ISO 4217 currency of these amounts. */
                                currency: string;
                            };
                            /**
                             * @description Refundability WITNESS, not a boolean. 'available' = a free-cancellation Book-on-Wego rate was seen in this snapshot. 'unknown' = none was seen, which is NOT evidence that none exists – this envelope carries only a sample of each hotel's rates, so a negative is not computable here. To answer 'does this hotel have a refundable room', read the hotel's rooms/rates.
                             * @enum {string}
                             */
                            refundable: "available" | "unknown";
                            /** @description Lowest refundable Book-on-Wego rate. Present exactly when refundable is 'available'. */
                            lowestRefundablePrice?: {
                                /**
                                 * @description What every amount here covers: the whole booking, all rooms in the search.
                                 * @constant
                                 */
                                scope: "booking";
                                /** @description One night of the whole booking, in the response currency, covering every room. Excludes localTaxPerNight, and taxAmountPerNight when that field appears. Rounded to a whole currency unit upstream; total is the exact stay figure. */
                                amountPerNight: number;
                                /** @description Per-night tax charged on top of amountPerNight, in the response currency. Present only when the amount excludes it; absent means amountPerNight already covers any such tax, which is the usual case. Add it the same way as localTaxPerNight. */
                                taxAmountPerNight?: number;
                                /** @description Per-night local tax (city/tourism/municipality), charged on top of amountPerNight. wego.com adds it to the price it displays. Present when upstream reports the tax, where 0 means none charged. Absent when upstream reports it as unknown. */
                                localTaxPerNight?: number;
                                /** @description Stay total of local tax as reported upstream, which rounds the nightly figure. Present when upstream reports the tax. Absent when upstream reports it as unknown. */
                                totalLocalTax?: number;
                                /** @description Stay total in the response currency. Excludes totalLocalTax, mirroring amountPerNight. */
                                total?: number;
                                /** @description The discount advertised on this rate, absent when the rate carries none. Describes THIS price object, so with ?refundable=true it describes the refundable rate the card switched to. */
                                deal?: {
                                    /** @description The offer's own tag, e.g. 'Best Deal'. Its presence also says where wasPerNight came from: see that field. */
                                    label?: string;
                                    /** @description The offer's discount as a whole percent. A tagged offer's percent wins over a usual-price one, matching the site's precedence, and the two often differ. wego.com renders a percentage only for an UNTAGGED offer; a tagged one it shows as its label plus a crossed-out price, so do not attribute this figure to what the page displays. Always describes the same offer as wasPerNight, so the pair never disagree. */
                                    percentOff: number;
                                    /** @description Pre-discount per-night price, on amountPerNight's basis so the two subtract cleanly. When label is present this is COMPUTED back from the offer's unrounded discount, since a tagged offer carries no pre-discount price of its own and wego.com renders the same computed figure; quote it as approximate, and expect it to differ slightly from a figure you derive using the rounded percentOff. When label is absent it is the quoted pre-discount price itself. */
                                    wasPerNight?: number;
                                    /** @description Pre-discount stay total, on total's basis. Computed or quoted on the same rule as wasPerNight. */
                                    wasTotal?: number;
                                    /** @description Promo code the traveller enters at checkout, when the offer carries one. Most live offers are provider discounts with no code. */
                                    promoCode?: string;
                                };
                                /** @description Stay total in USD, the cross-currency ranking key. */
                                totalUsd: number;
                                /** @description ISO 4217 currency of these amounts. */
                                currency: string;
                            };
                            /** @description Rate types WITNESSED on this hotel's Book-on-Wego rates in this snapshot (e.g. breakfast_included, free_cancellation), sorted. A witness on the same terms as refundable, never a negative: this envelope carries only a sample of each hotel's rates, so an absent type is not evidence the hotel lacks it. These are the exact values ?rate-types= accepts, and the same vocabulary metadata.filterOptions.rateTypes counts. Omitted when no rate type was witnessed. */
                            rateTypes?: string[];
                            /** @description City the hotel is in. */
                            cityName?: string;
                            /** @description District or neighbourhood the hotel is in. */
                            districtName?: string;
                            /** @description Hotel latitude in decimal degrees. Use with lng to compute distance to any landmark you choose. */
                            lat?: number;
                            /** @description Hotel longitude in decimal degrees. Use with lat to compute distance to any landmark you choose. */
                            lng?: number;
                            /** @description Kilometres from the city's place-record coordinate (the point GET /v1/places reports for the city), and the ?sort=distance_asc key. Where a city record covers an island, a city-state or a whole administrative area, that point can sit far from the commercial centre. For locality prefer the districts filter, or compute distance from lat/lng to a landmark you choose. Present when upstream reports it. */
                            distanceToCityCentre?: number;
                            /** @description Primary image URL, if any. */
                            image?: string;
                            /** @description Full-result-set badges this hotel wins (e.g. cheapest). */
                            badges: string[];
                        }[];
                    };
                };
            };
            /** @description Invalid request parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown or expired search. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream hotels service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The hotels service is unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHotelRateBookingLink: {
        parameters: {
            query?: {
                /** @description Optional. The search the rate belongs to. When omitted it defaults to the rate id's first segment (exactly how the checkout page recovers it), so you rarely need to send it; when sent it must equal that segment or the request is rejected 400. */
                searchId?: string;
                /** @description Checkout page language tag (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Optional. The adults and child ages to put on the checkout URL, written as the adult count then one age per child: 2:4:9 is 2 adults with children aged 4 and 9. It does not change what checkout charges, which comes from the search the rate id names, so a different value here, or none at all, opens the same stay at the same price. */
                guests?: string;
                /** @description Optional. An ISO 3166-1 alpha-2 country code to put on the checkout URL, such as AE. On wego.com this names the country of the place searched, not the traveller's. It does not choose which wego.com site the link opens (that is siteCode), and it does not change the price: the checkout page asks the traveller for their nationality on its own form. */
                countryCode?: string;
                /** @description Wego market (point of sale) as a 2-letter code, e.g. AE; defaults to US. It selects the wego.com CHECKOUT HOST/domain – distinct from countryCode, which is copied onto the link and changes neither the host nor the price. */
                siteCode?: string;
            };
            header?: never;
            path: {
                /** @description The hotel's numeric id (a positive integer), as carried by hotel search results (results[].hotelId) and embedded in a rate id. */
                hotelId: number;
                /** @description The rate's composed booking reference from GET /v1/hotels/{hotelId}/rates (rates[].id), forwarded verbatim. Grammar: {searchId}:hotels.wego.com:{hotelId}:{hash}:{idx} – checkout derives the search from the first segment, which is why the searchId query param is optional here. Opaque: do not construct or reorder it. */
                rateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The checkout URL, and the fact that it expires. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The wego.com hotel checkout URL for the rate. */
                        bookingUrl: string;
                        /**
                         * @description Always true: this link is search-scoped and stops working when the rate's search expires. A stale link loads an empty checkout page rather than erroring, so treat it as short-lived and re-price the rate to get a fresh one. To send someone a link that lasts, use the hotel's pageUrl.
                         * @constant
                         */
                        expires: true;
                    };
                };
            };
            /** @description Invalid request parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHotelSearchLink: {
        parameters: {
            query: {
                /** @description City code the link searches, e.g. BKK. Take it from a places result's code or cityCode, never its numeric id. A lat/lng pair cannot be shared: wego.com serves no coordinate search URL. To link one hotel instead of a search, use the pageUrl that hotel carries. */
                cityCode: string;
                /** @description Check-in date, YYYY-MM-DD. Not in the past. */
                checkIn: string;
                /** @description Check-out date, YYYY-MM-DD. Must be after checkIn. */
                checkOut: string;
                /** @description Adults across the link's rooms (1-9). Defaults to 2. */
                adults?: number;
                /** @description Children across the link's rooms (0-8). Defaults to 0. Sending more than 0 requires childrenAges. */
                children?: number;
                /** @description Per-child ages as a comma-separated list of integers 0-17, e.g. 5,9. The count must equal children, and it is required whenever children is above 0: the create body prices a missing age at 8, and a durable link would show that guess to a recipient who cannot correct it. */
                childrenAges?: string;
                /** @description Rooms the link asks for (1-4). Defaults to 1, and cannot be more than adults. Guests spread evenly and fill the earlier rooms first, so 3 adults in 2 rooms give 2 then 1, matching the way a search prices the same stay. */
                rooms?: number;
                /** @description Optional pricing currency as a 3-letter ISO 4217 code. When omitted the page prices in whatever the recipient's own session uses. */
                currency?: string;
                /** @description Page language tag (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Wego market (point of sale) as a 2-letter code, e.g. AE; defaults to US. It selects the wego.com host the link points at. */
                siteCode?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The durable wego.com hotel-search URL. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A wego.com hotel-search URL for this city, dates and occupancy. Opening it runs the search live. */
                        searchUrl: string;
                        /**
                         * @description Always false: the URL carries no search-scoped id, so it keeps working. The prices behind it are whatever a live search returns when it is opened.
                         * @constant
                         */
                        expires: false;
                    };
                };
            };
            /** @description Invalid query parameters. checkIn must be a real calendar date and not in the past; checkOut must be after it; rooms is 1-4 and cannot be more than adults; childrenAges is required when children is above 0 and must have exactly that many entries. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHotelRates: {
        parameters: {
            query: {
                /** @description The search the hotel was found in (from createHotelSearch); rates are priced within that search context. Required. */
                searchId: string;
                /** @description Pricing currency as a 3-letter ISO 4217 code (e.g. AED). Defaults to USD. */
                currency?: string;
                /** @description Response language tag (e.g. en, ar). Defaults to en. */
                locale?: string;
            };
            header?: never;
            path: {
                /** @description The hotel's numeric id (a positive integer), as carried by hotel search results (results[].hotelId) and embedded in a rate id. */
                hotelId: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cheapest-first Book-on-Wego rates. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The hotel these rates are for. */
                        hotelId: number;
                        /** @description The search these rates were priced within. */
                        searchId: string;
                        /** @description The currency every rate price on this read was computed in – the same value as metadata.currencyCode, which carries currencyCodeSource beside it. Read it before you show a number: a price computed in the wrong currency renders as a perfectly normal price. */
                        currencyCode: string;
                        /** @description Advisory: true means upstream reports it finished aggregating rates for this search. It is not a guarantee that the list on this page is final, so do not block on it. */
                        searchComplete: boolean;
                        /** @description What upstream priced: the dates and occupancy every price on this read covers. Present when upstream states them. */
                        stay?: {
                            /** @description Check-in date priced upstream, YYYY-MM-DD. */
                            checkIn: string;
                            /** @description Check-out date priced upstream, YYYY-MM-DD. */
                            checkOut: string;
                            /** @description Nights between checkIn and checkOut. price.total covers this many nights of price.amountPerNight. */
                            nights: number;
                            /** @description The occupancy priced upstream for this search (ages resolved, incl. fallback). */
                            occupancy: {
                                /** @description Adults priced upstream for this search. */
                                adults: number;
                                /** @description Resolved per-child ages actually sent upstream (age-8 fallback when omitted). */
                                childrenAges: number[];
                                /** @description Rooms priced upstream for this search. */
                                rooms: number;
                            };
                        };
                        /** @description Bookable rates for the hotel in this search. */
                        rates: {
                            /** @description Composed booking reference (opaque passthrough); pass it to GET /v1/hotels/{hotelId}/rates/{rateId}/booking-link. */
                            id: string;
                            /** @description Room type name, e.g. Deluxe King. */
                            roomName: string;
                            /** @description Board basis, normalized to lower_snake_case (e.g. room_only, breakfast_included). Absent when the provider states none. */
                            board?: string;
                            /** @description True when this rate carries a refundable or free-cancellation code. Authoritative on this endpoint, unlike the results card's refundable witness. */
                            refundable: boolean;
                            /** @description Coarse policy derived from the refundability codes: free_cancellation or non_refundable. */
                            cancellationPolicy?: string;
                            /** @description A rate's pricing. Every amount covers the whole booking, all rooms in the search, so quote these figures as they stand. Upstream rounds per booking, so total is the exact stay figure and amountPerNight is one night of it. All amounts exclude totalLocalTax, which wego.com adds to the displayed price. */
                            price: {
                                /**
                                 * @description What every amount here covers: the whole booking, all rooms in the search.
                                 * @constant
                                 */
                                scope: "booking";
                                /** @description One night of the whole booking, in the request currency, covering every room. Rounded to a whole currency unit upstream; total is the exact stay figure. */
                                amountPerNight: number;
                                /** @description Per-night tax, when reported. */
                                taxAmountPerNight?: number;
                                /** @description Whether amountPerNight already includes taxAmountPerNight. Says nothing about localTaxPerNight, which is excluded either way. */
                                taxInclusive?: boolean;
                                /** @description Per-night local tax (city / tourism / municipality), charged on top of amountPerNight whatever taxInclusive says. wego.com quotes amountPerNight + localTaxPerNight, so quote both. Present when upstream reports the tax, where 0 means none charged. Absent when upstream reports it as unknown. */
                                localTaxPerNight?: number;
                                /** @description Stay total of localTaxPerNight as reported upstream, which rounds the nightly figure. Present when upstream reports the tax. Absent when upstream reports it as unknown. */
                                totalLocalTax?: number;
                                /** @description Stay total in the request currency. Excludes totalLocalTax, mirroring amountPerNight. */
                                total?: number;
                                /** @description Stay total in USD – the cross-currency sort key. */
                                totalUsd: number;
                                /** @description ISO 4217 currency of the amounts on this price. */
                                currency: string;
                                /** @description The discount advertised on this room's rate, absent when it carries none. Rooms commonly share one offer, so treat a deal here as a property of the rate rather than as a rare find, and compare percentOff across the rooms before recommending one. */
                                deal?: {
                                    /** @description The offer's own tag, e.g. 'Best Deal'. Its presence also says where wasPerNight came from: see that field. */
                                    label?: string;
                                    /** @description This room's discount as a whole percent. A tagged offer's percent wins over a usual-price one, matching the site's precedence, and the two often differ. wego.com renders a percentage only for an UNTAGGED offer; a tagged one it shows as its label plus a crossed-out price, so do not attribute this figure to what the page displays. Always describes the same offer as wasPerNight, so the pair never disagree. */
                                    percentOff: number;
                                    /** @description Pre-discount per-night price, on amountPerNight's basis so the two subtract cleanly. When label is present this is COMPUTED back from the offer's unrounded discount, since a tagged offer carries no pre-discount price of its own and wego.com renders the same computed figure; quote it as approximate, and expect it to differ slightly from a figure you derive using the rounded percentOff. When label is absent it is the quoted pre-discount price itself. */
                                    wasPerNight?: number;
                                    /** @description Pre-discount stay total, on total's basis. Computed or quoted on the same rule as wasPerNight. */
                                    wasTotal?: number;
                                    /** @description Promo code the traveller enters at checkout, when the offer carries one. Most live offers are provider discounts with no code. Scoped to this room's rate; wego.com instead shows one such code above the whole room list. */
                                    promoCode?: string;
                                };
                            };
                            /** @description Rooms remaining at this rate, when the provider reports scarcity; absent otherwise. */
                            roomsLeft?: number;
                            /** @description Room image URLs, when the provider supplies them. */
                            images?: string[];
                        }[];
                        /** @description What this read resolved currency and locale to, and how each was decided. */
                        metadata: {
                            /** @description The currency this read ASKED upstream for, and the one every price on it is meant to be in. Read it beside currencyCodeSource before you show a number: a price computed in the wrong currency renders as a perfectly normal price, with no error and no odd shape to notice, so the response states which one rather than leaving it to be inferred. Where the operation also publishes a top-level currencyCode, that field reports the currency the prices actually came back in; the two agree unless upstream declined to reprice. */
                            currencyCode: string;
                            /**
                             * @description How the API resolved currencyCode: explicit (the caller sent currency – including a value equal to the default) or default (USD, no currency sent). A default here is the one signal that the request never carried the currency you meant.
                             * @enum {string}
                             */
                            currencyCodeSource: "explicit" | "default";
                            /** @description The language tag this read asked upstream for – what any localized text on it was resolved in (room and board names, airline and airport names, review prose). */
                            locale: string;
                            /**
                             * @description How the API resolved locale: explicit (the caller sent locale – including a value equal to the default) or default (en, no locale sent). A default here explains text that came back in a language the caller did not ask for.
                             * @enum {string}
                             */
                            localeSource: "explicit" | "default";
                        };
                    };
                };
            };
            /** @description Invalid request parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown hotel, or unknown/expired search. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The searchId names a city or geo search, which never holds a hotel's full rate list. Create a hotel-scoped search (createHotelSearch with hotelId) and read its rates. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream hotels service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The hotels service is unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHotelReviews: {
        parameters: {
            query?: {
                /** @description Page number, 1-based (max 100). Defaults to 1. */
                page?: number;
                /** @description Reviews per page (1-50). Defaults to 10. */
                pageSize?: number;
                /** @description Sort order. posted_at_desc (default, newest first) – a review corpus answers 'what is it like now', so recency opens; rating_desc / rating_asc sort by the provider's rating. */
                sort?: "posted_at_desc" | "rating_desc" | "rating_asc";
                /** @description Response language tag (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Optional topic terms to filter reviews by (repeat or comma-separate, OR'd together) – e.g. ?topics=breakfast,pool keeps reviews mentioning either. metadata.matchedTerms reports the variants actually matched (breakfast, Breakfast). */
                topics?: string[];
                /** @description Optional reviewer-cohort filter: couple, family_with_children, solo_traveller or extended_group. */
                "guest-type"?: "couple" | "family_with_children" | "solo_traveller" | "extended_group";
                /** @description Response projection. default: rating, title, pros, cons, provider. detail: adds the reviewer's country code and neutral prose notes. Defaults to default. */
                view?: "default" | "detail";
            };
            header?: never;
            path: {
                /** @description The hotel's numeric id (a positive integer), as carried by hotel search results (results[].hotelId) and embedded in a rate id. */
                hotelId: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of guest reviews. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The hotel these reviews are for. */
                        hotelId: number;
                        /** @description Pagination and the matched-topic accounting for this reviews read. */
                        metadata: {
                            /** @description 1-based page number of this read. */
                            page: number;
                            /** @description Reviews requested per page. */
                            pageSize: number;
                            /** @description Reviews on this page. */
                            resultCount: number;
                            /** @description Reviews matching this read's filters across ALL pages – the denominator to quote a review against ('15 of 141'). It is the FILTERED total, so an unfiltered read is needed to state the hotel's full review count. EXACT only when hasMore is false: when hasMore is true this can be a LOWER BOUND, because an upstream page that carries no count of its own falls back to the offset plus the rows it sent, so quote it as 'at least N'. ABSENT when this read establishes no total at all – an empty page past the first whose upstream sent no count says nothing about the pages before it. Absent means UNKNOWN, never zero: re-read page 1 before reporting any number. */
                            totalCandidates?: number;
                            /** @description Another page may follow. A full page always sets this, count or no count. While it is true, read totalCandidates as a floor rather than a corpus size. */
                            hasMore: boolean;
                            /** @description The topic terms this read asked for. */
                            topics: string[];
                            /** @description The term variants the upstream actually matched (e.g. breakfast, Breakfast). Empty on an unfiltered read. Cite from here rather than from topics, so a quote states the word that was really found. */
                            matchedTerms: string[];
                        };
                        /** @description The requested page of guest reviews. */
                        results: {
                            /** @description The provider's own 0–10 rating for this review, passed through. */
                            rating: number;
                            /** @description Review title, when the guest gave one. */
                            title?: string;
                            /** @description Calendar date (YYYY-MM-DD). */
                            postedAt: string;
                            /** @description Which provider collected the review (e.g. booking.com). */
                            providerCode: string;
                            /**
                             * @description The reviewer's cohort, normalized onto the closed set. Omitted when the upstream sent a value outside it.
                             * @enum {string}
                             */
                            guestType?: "couple" | "family_with_children" | "solo_traveller" | "extended_group";
                            /** @description What the guest liked, verbatim. */
                            pros: string[];
                            /** @description What the guest disliked, verbatim. */
                            cons: string[];
                            /** @description view=detail only – review prose the provider tagged neither positive nor negative. */
                            notes?: string[];
                            /** @description view=detail only – the reviewer's country code. The reviewer's name is never returned. */
                            countryCode?: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown hotel. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream hotels service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The hotels service is unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHotel: {
        parameters: {
            query?: {
                /** @description Response language tag (e.g. en, ar). Defaults to en. */
                locale?: string;
                /** @description Response projection. default: the agent hotel detail. detail: the richer UI projection (categorized images, review highlights, badges). Defaults to default. */
                view?: "default" | "detail";
            };
            header?: never;
            path: {
                /** @description The hotel's numeric id (a positive integer), as carried by hotel search results (results[].hotelId) and embedded in a rate id. */
                hotelId: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hotel detail (agent default) or the detail projection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The hotel's numeric id. */
                        hotelId: number;
                        /** @description Hotel display name. */
                        name: string;
                        /** @description The hotel's page on wego.com. It is not tied to a search, so it keeps working after this search expires. Give it to a traveller who wants to look at the hotel, and use it in anything that is saved or sent on. It opens with no dates set. */
                        pageUrl: string;
                        /** @description Star rating (1-5), when classified. */
                        star?: number;
                        /** @description Aggregate guest review score and count. */
                        review?: {
                            /** @description Aggregate guest review score (0-10). */
                            score: number;
                            /** @description Number of guest reviews behind the score. */
                            count: number;
                        };
                        /** @description Where the hotel is: coordinates and place names. */
                        location: {
                            /** @description Latitude in decimal degrees. */
                            lat?: number;
                            /** @description Longitude in decimal degrees. */
                            lng?: number;
                            /** @description Street address, when available. */
                            address?: string;
                            /** @description City name. */
                            cityName?: string;
                            /** @description District or neighbourhood name. */
                            districtName?: string;
                            /** @description Country name. */
                            countryName?: string;
                        };
                        /** @description Property type, e.g. Hotel, Apartment. */
                        propertyType?: string;
                        /** @description Brand name, when the hotel belongs to one. */
                        brandName?: string;
                        /** @description Parent chain name, when known. */
                        chainName?: string;
                        /** @description Editorial description of the hotel. */
                        description?: string;
                        /** @description Hotel-level amenity names. */
                        amenities?: string[];
                        /** @description Hotel image URLs. */
                        images?: string[];
                        /** @description Kilometres from the city's place-record coordinate (the point GET /v1/places reports for the city). Where a city record covers an island, a city-state or a whole administrative area, that point can sit far from the commercial centre. For a specific landmark, compute distance from location.lat/lng. Present when upstream reports it. */
                        distanceToCityCentre?: number;
                        /** @description Distance to the nearest airport, as the upstream reports it (unit not normalized here). Absent when upstream omits it. */
                        distanceToNearestAirport?: number;
                        /** @description view=detail only – hotel images grouped by category (e.g. Rooms, Pool). Absent when the content service supplies none. */
                        categorizedImages?: {
                            /** @description Image category name, e.g. Rooms, Pool. */
                            category: string;
                            /** @description Images in this category. */
                            images: {
                                /** @description Image URL. */
                                url: string;
                                /** @description Alt text for the image, when provided. */
                                altText?: string;
                            }[];
                        }[];
                        /** @description view=detail only – short editorial review snippets with a sentiment tag. Absent when none are published. */
                        reviewHighlights?: {
                            /** @description Sentiment tag for the snippet, e.g. positive, negative. */
                            sentiment?: string;
                            /** @description The review snippet text. */
                            text: string;
                        }[];
                        /** @description Editorial badges from the hotel content service. */
                        highlights?: {
                            /** @description Badge label. */
                            text: string;
                            /** @description Badge supporting text, when present. */
                            subtext?: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Missing or invalid bearer token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unknown hotel. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limit exceeded; retry after the `Retry-After` seconds. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The upstream hotels service returned an invalid response. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The hotels service is unavailable (`upstream_unavailable`) or rate-limited upstream (`upstream_rate_limited`); retry after the `Retry-After` seconds. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
}
