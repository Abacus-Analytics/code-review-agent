# Codebase Context for AI Code Review

> Drop this file in the **root of your repo** as `CODEBASE_CONTEXT.md`.
> The AI review agent reads this before every review so it understands
> your architecture, patterns, and team conventions.
>
> **Delete the sections you don't need. Fill in what matters.**

---

## Tech Stack

- **Framework:** .NET 8, Blazor Server (or WASM — update as needed)
- **ORM:** Entity Framework Core 8
- **Database:** SQL Server (Azure SQL)
- **Cloud:** Azure App Service, Azure Blob Storage, Azure Key Vault
- **Auth:** ASP.NET Core Identity with Azure AD / [your auth approach]
- **Frontend:** Blazor components with [Radzen / MudBlazor / custom]

## Architecture Overview

<!-- Describe the high-level structure of your app. Example: -->

```
src/
  Abacus.Web/           → Blazor Server app (UI layer)
  Abacus.Core/          → Business logic, domain models, interfaces
  Abacus.Infrastructure/→ EF Core, Azure services, external APIs
  Abacus.Shared/        → DTOs, enums, constants shared across layers
```

The app follows a **Clean Architecture** pattern:
- **Web** depends on **Core** and **Infrastructure**
- **Core** has no dependencies on other project layers
- **Infrastructure** implements interfaces defined in Core

## Key Patterns & Conventions

### Dependency Injection
- All services are registered in `Program.cs` via extension methods
- Use constructor injection everywhere — no `ServiceLocator` pattern
- Scoped lifetime for DB contexts, transient for stateless services

### Database Access
- All database access goes through repository interfaces in `Core/Interfaces/`
- Repositories are implemented in `Infrastructure/Repositories/`
- Never access `DbContext` directly from Blazor components or controllers
- Always use `AsNoTracking()` for read-only queries
- Always use `Select()` projections for list/grid queries

### Error Handling
- Use `Result<T>` pattern for service return types (no exceptions for business logic)
- Log exceptions with `ILogger<T>`, never `Console.WriteLine`
- Global exception handler in `Program.cs` for unhandled exceptions

### Blazor Components
- One component per file
- State management via cascading parameters or dedicated state services
- Never call `StateHasChanged()` in a loop — batch updates
- Dispose event handlers in `IDisposable.Dispose()`

### API Controllers
- All controllers inherit from `AbacusBaseController`
- Every action must have `[Authorize]` (or explicitly `[AllowAnonymous]`)
- Use `ActionResult<T>` return types, not `IActionResult`
- Validate input with FluentValidation, not data annotations

### Naming Conventions
- Interfaces: `IUserService`, `IOrderRepository`
- Implementations: `UserService`, `OrderRepository`
- DTOs: `UserDto`, `CreateOrderRequest`, `OrderResponse`
- Blazor components: PascalCase filenames matching class name
- Database tables: plural (`Users`, `Orders`, `OrderItems`)

## Things the Review Agent Should Know

<!-- Add anything else that would help the agent review your code better. -->

- We use **feature flags** via Azure App Configuration — check `IFeatureManager` usage
- **Soft deletes** are standard — entities have `IsDeleted` and `DeletedAt` fields
- Multi-tenancy is handled by a `TenantId` filter on the DbContext
- File uploads go to Azure Blob Storage, never the local filesystem
- All monetary values use `decimal`, never `double` or `float`

## Common Mistakes to Watch For

<!-- List things your team commonly gets wrong in code review. -->

- Forgetting to add `[Authorize]` on new controller actions
- Using `FirstOrDefault()` without a null check on the result
- Not including related entities with `.Include()` and getting N+1 queries
- Putting business logic in Blazor code-behind instead of services
- Using `async void` instead of `async Task` in event handlers
- Hardcoding connection strings or API keys instead of using Key Vault
