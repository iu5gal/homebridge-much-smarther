# Funzioni e limiti

*[English](../en/features.md)*

Cosa fa il termostato quando usi l'app Casa, cosa aggiunge la pagina di configurazione e cosa non si può fare. L'inventario completo, con i dettagli del protocollo e le fonti, è in [FEATURES.md](../FEATURES.md), in inglese.

## L'app Casa e il termostato

Il termostato dell'app Casa ha solo quattro modi, Spento, Caldo, Freddo e Auto, e non conosce il "fino a". Il plugin li fa corrispondere ai modi del termostato così:

| Nell'app Casa | Sul termostato | Note |
| --- | --- | --- |
| **Auto** | Il programma settimanale (`AUTOMATIC`) | Torna al programma attivo. Con l'opzione "come interruttore Programma separato" il modo Auto non c'è e lo fa l'interruttore **Programma**. |
| **Caldo** (d'inverno) o **Freddo** (d'estate) | Una temperatura manuale (`MANUAL`) | Caldo è il modo in cui l'app Casa mostra il manuale del termostato: l'app non ha un "manuale". Scegliere Caldo da Spento riporta l'ultima temperatura impostata, o il livello "Casa". Sceglierlo durante il programma mantiene la temperatura attuale come manuale. |
| **Spento** | Spento, alla temperatura di protezione (`PROTECTION`) | Come lo "Spegni" dell'app BTicino: il termostato mantiene la temperatura antigelo, 7 °C se non l'hai cambiata. |
| Spostare la **temperatura impostata** | Una temperatura manuale, fino al prossimo cambio di livello del programma | Come propone l'app BTicino. Il plugin aspetta che tu smetta di muovere il cursore, poi invia un solo comando. In alternativa: fino a nuovo comando, o per un tempo fisso. |
| Interruttori **Boost 30 / 60 / 90 min** | `BOOST` per quel tempo | L'impianto resta acceso qualunque sia la temperatura. Un interruttore alla volta; spegnere quello attivo torna al programma. Un boost avviato dal pannello o dall'app accende l'interruttore corrispondente. |
| Un interruttore di **programma** | Quel programma settimanale | Facoltativo. Ne è acceso uno alla volta, come i pulsanti di una radio. |
| Interruttore **Spento fino al prossimo cambio** | Spento fino al prossimo cambio di livello del programma | Facoltativo. Spegnerlo torna al programma. |

L'app Casa mostra anche:

- la temperatura della stanza, con un guasto se il termostato segnala la misura come non valida;
- l'umidità, nel termostato e nel suo riquadro di sensore;
- se in questo momento l'impianto sta scaldando (o raffrescando).

Le modifiche fatte dal pannello o dall'app BTicino compaiono nell'app Casa entro pochi secondi: il termostato le annuncia, e il plugin non deve interrogarlo di continuo.

### Stagioni

L'app Casa offre solo la stagione in corso: Caldo d'inverno, Freddo d'estate. La stagione si cambia dalla pagina di configurazione, dall'app BTicino o dal pannello. Permetterlo dall'app Casa è un'opzione, disattivata, pensata solo per impianti che scaldano e raffrescano con questo termostato: con una semplice caldaia, il raffrescamento accenderebbe la caldaia.

## La pagina di configurazione

La pagina di configurazione nell'interfaccia di Homebridge aggiunge quello che l'app Casa non sa mostrare:

- temperatura manuale **fino a un giorno e un'ora a scelta**, fino a 10 giorni dopo, o fino a nuovo comando;
- **spento fino a** un giorno e un'ora a scelta;
- il tempo che resta al modo attuale e il prossimo cambio di livello del programma;
- la **scelta del programma attivo**, con i nomi dell'app BTicino;
- la **stagione**, con una conferma;
- le **impostazioni** del termostato, in sola lettura: livelli di temperatura, temperature di protezione, isteresi, calibrazione, opzioni del pannello, firmware e diagnostica.

Vedi la [guida alla configurazione](setup.md#5-il-resto-della-pagina).

## Convivenza con l'app BTicino

- **L'app BTicino continua a funzionare** attraverso il cloud BTicino, come sempre, anche fuori casa. Le modifiche fatte lì arrivano nell'app Casa in pochi secondi, e viceversa.
- **Un solo client locale alla volta.** Il termostato accetta una sola sessione sulla rete di casa, e la tiene il plugin. Quindi, **senza internet**, l'app BTicino non raggiunge il termostato finché Homebridge è attivo; ci riesce solo l'app Casa. Anche altri strumenti locali vengono rifiutati.

## Limiti

- **I programmi settimanali non si modificano** dall'app Casa né dalla pagina di configurazione: si creano e si cambiano nell'app BTicino. La pagina sceglie solo quale è attivo.
- **Le impostazioni sono in sola lettura**: livelli di temperatura, temperature di protezione, isteresi, calibrazione e opzioni del pannello si cambiano nell'app BTicino o dal pannello.
- **Un solo termostato per istanza di Homebridge**, in questa versione.
- **Il raffrescamento** è supportato ma provato solo con il simulatore, non su un vero impianto di raffrescamento.
- **"Fuori casa"** (il livello Fuori casa fino a un'ora a scelta) non è offerto: l'app non lo proponeva sull'impianto usato per le prove.
- **L'accesso remoto** non fa parte del progetto: fuori casa usa l'app BTicino, oppure un hub domestico Apple per l'app Casa.
- **Le funzioni dell'app e del cloud** restano nell'app BTicino: meteo, suggerimenti basati sulla posizione, aggiornamenti del firmware, configurazione del Wi-Fi, più case e comandi per tutta la casa, assistenti vocali.
- **Hindi e thai** hanno i nomi inglesi nell'app Casa (la pagina di configurazione resta tradotta).

## Non ancora osservato

Non incide sull'uso normale, ma non è ancora stato visto su un termostato reale:

- la fine naturale di un boost, quando il suo tempo scade (il plugin segue quello che il termostato comunica);
- quando, se mai, il termostato indica il modo `OFF` invece di `PROTECTION`;
- cosa fa il termostato con una temperatura manuale più bassa della sua temperatura di protezione.
