# Security Policy

## Supported Versions

The module is in pre-alpha development. Security fixes will be applied to the latest tagged release only.

| Version | Supported |
|---------|-----------|
| 0.0.x   | ✅ (latest) |

Pre-alpha releases will transition to supported stable releases as Tier 1 lands.

## Reporting a Vulnerability

**Please do not report security issues via public GitHub issues.** Public disclosure of a security flaw before a fix is available puts other users at risk.

To report a security issue privately:

1. Open a [GitHub security advisory](https://github.com/savevsgames/stablepiggy-napoleon-game-assistant/security/advisories/new) on this repository, OR
2. Contact the maintainer directly via the contact info in the repository profile

Include in your report:
- A description of the issue
- The affected version(s)
- Steps to reproduce
- The potential impact (what an attacker could do)
- Any suggested fix, if you have one

You will receive an acknowledgment within 72 hours. Valid reports will be triaged and a fix planned. You will be credited in the changelog (if you want to be) once the fix ships.

## Scope

In-scope security concerns for this module:
- Issues in the Foundry VTT client module code that allow unauthorized actions in a GM's world
- Issues in the relay service (authentication bypass, command injection, unauthorized access to the AI backend)
- Issues in the command protocol (replay attacks, message tampering, cross-world leaks)
- Credential exposure in logs, error messages, or client-side storage

Out of scope:
- Security concerns in Foundry VTT itself → report to [foundryvtt.com](https://foundryvtt.com)
- Security concerns in the pf2e system module → report to [github.com/foundryvtt/pf2e](https://github.com/foundryvtt/pf2e)
- Security concerns in the StablePiggy platform → report via the platform's own security channel

## Responsible Disclosure

This module follows standard responsible-disclosure practice. We ask reporters to give the maintainer a reasonable window (typically 90 days) to ship a fix before publishing details of a vulnerability. We will work with you on a coordinated disclosure timeline if the issue is severe.

Thank you for helping keep the module and its users safe.
