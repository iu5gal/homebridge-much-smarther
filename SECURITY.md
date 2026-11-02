# Security policy

*[Italiano più sotto](#italiano)*

## Supported versions

Only the latest released version receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Report it privately through GitHub: on the repository page, open **Security → Report a vulnerability**. This uses GitHub's private vulnerability reporting, so only the maintainers see the report.

Please include:

- the affected version, and your Homebridge and Node.js versions;
- what an attacker can do, and under which conditions (for example "on the same LAN");
- the steps to reproduce, ideally against the simulator (`npm run simulator`) rather than a real thermostat.

**Never include real secrets or personal data:** no thermostat password (PswOpen), BTicino credentials, HomeKit setup codes, network captures, IP or MAC addresses of your installation. Use placeholders.

What to expect:

- an acknowledgement within 7 days;
- an assessment, and a plan or a fix, as soon as possible; this is a volunteer project;
- credit in the release notes, if you wish.

## Scope

In scope: this repository's code, that is the Homebridge plugin, its setup page, the core library and the tools.

Out of scope, but welcome as information:

- the thermostat's own protocol, which is not encrypted after the handshake, and the BTicino app and cloud: report those to BTicino / Legrand;
- Homebridge and its UI: report those to the Homebridge project.

The threat model, with the known residual risks, is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

---

## Italiano

**Non aprire una issue pubblica** per segnalare una vulnerabilità.

Segnalala in privato tramite GitHub: nella pagina del repository apri **Security → Report a vulnerability**. È la segnalazione privata di GitHub, che vedono solo i manutentori.

Indica la versione, cosa può fare un attaccante e in quali condizioni, e i passi per riprodurre il problema, se possibile con il simulatore.

**Non inserire mai segreti o dati personali reali:** niente password locale del termostato (PswOpen), credenziali BTicino, codici di abbinamento HomeKit, catture di rete, indirizzi IP o MAC del tuo impianto. Usa valori segnaposto.

Riceverai una conferma entro 7 giorni. È un progetto volontario: la correzione arriva appena possibile. Se vuoi, sarai citato nelle note di rilascio.

Sono fuori ambito il protocollo del termostato, l'app e il cloud BTicino, da segnalare a BTicino / Legrand, e Homebridge, da segnalare al progetto Homebridge. Il modello delle minacce è in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md), con una sintesi in italiano in [docs/it/security.md](docs/it/security.md).
