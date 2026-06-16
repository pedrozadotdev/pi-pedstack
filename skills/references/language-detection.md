# Language Detection

Detect the project's primary language by checking for these files in the repo root:

| File(s) | Language | Rules directory |
|---------|----------|----------------|
| `tsconfig.json` | TypeScript | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/typescript/` |
| `package.json` (without `tsconfig.json`) | JavaScript | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/typescript/` |
| `Cargo.toml` | Rust | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/rust/` |
| `go.mod` | Go | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/golang/` |
| `pubspec.yaml` | Dart | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/dart/` |
| `pom.xml` / `build.gradle` | Java | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/java/` |
| `*.sln` / `*.csproj` | C# | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/csharp/` |
| `Package.swift` | Swift | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/swift/` |
| `requirements.txt` / `pyproject.toml` / `setup.py` | Python | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/python/` |
| `composer.json` | PHP | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/php/` |
| `Makefile.PL` / `cpanfile` | Perl | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/perl/` |
| `build.gradle.kts` | Kotlin | `~/.pi/agent/git/github.com/pedrozadotdev/pi-pedstack/rules/kotlin/` |

## Rules loading strategy

Rules are loaded from two locations with priority:

1. **Project-level** `{repo-root}/rules/` — takes priority, survives `pi update`.
2. **Package-level** `rules/` in the pi-pedstack package — built-in defaults.

Check project-level first. If a file exists there for the topic, use it. Otherwise fall back to package-level.

## Rule precedence

```
language-specific > web > common
```

Override mapping by topic:

- `common/testing.md` ← `web/testing.md` ← `<lang>/testing.md`
- `common/coding-style.md` ← `web/coding-style.md` ← `<lang>/coding-style.md`
- `common/patterns.md` ← `web/patterns.md` ← `<lang>/patterns.md`
- `common/security.md` ← `web/security.md` ← `<lang>/security.md`
- `common/hooks.md` ← `web/hooks.md` ← `<lang>/hooks.md`

## Do not load all rules at once

Only load what the current task needs. See each skill's SKILL.md for phase-specific loading instructions.
