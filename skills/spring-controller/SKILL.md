---
name: spring-controller
description: Add a Spring Boot REST controller backed by a service and DTOs
category: frameworks
---

# Spring Controller

Use to expose a new REST endpoint in a Spring Boot app, layering controller → service → repository with proper DTOs and status codes.

1. Define request/response DTOs (records work well) and validation annotations (`@NotNull`, `@Size`, …) — don't expose entities directly.
2. Create a `@RestController` with a class-level `@RequestMapping("/api/...")`; inject the service via constructor.
3. Add handler methods with `@GetMapping`/`@PostMapping`/etc., binding `@RequestBody`/`@PathVariable`/`@RequestParam` and `@Valid` on bodies.
4. Put business logic in a `@Service` bean; keep the controller to mapping, validation, and response shaping.
5. Return `ResponseEntity<T>` with correct status codes; handle errors centrally via `@ControllerAdvice`/`@ExceptionHandler`.
6. Run the app (`./mvnw spring-boot:run` or `./gradlew bootRun`) and exercise the endpoint with curl/HTTP client.

## Rules
- Never serialize JPA entities over the wire — map to DTOs to avoid lazy-loading and over-exposure bugs.
- Use constructor injection (final fields), not field `@Autowired`.
- Validate input with `@Valid` and surface failures as 400s via a global exception handler, not stack traces.
- Keep controllers free of persistence/transaction logic; `@Transactional` belongs in the service layer.
- Choose accurate status codes (201 + `Location` on create, 404 on missing, 204 on delete).
