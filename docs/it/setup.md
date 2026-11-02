# Configurazione

*[English](../en/setup.md)*

Dopo l'[installazione](installation.md), il plugin ha bisogno dell'indirizzo del termostato e della sua password locale. Si fa tutto dalla pagina di configurazione del plugin, nell'interfaccia di Homebridge.

## 1. Apri la pagina di configurazione

Nell'interfaccia di Homebridge apri **Plugin**, trova **Much Smarther** e apri le sue impostazioni dal menu della sua scheda. La pagina compare nella lingua scelta nelle impostazioni del plugin, in inglese finché non la cambi.

## 2. Indirizzo e lingua

1. In **Impostazioni del plugin** scrivi l'**Indirizzo del termostato**: il suo indirizzo IP nella tua rete, per esempio `192.0.2.10`. Deve essere fisso sul router.
2. Scegli la **Lingua** della pagina e dei nomi nell'app Casa.
3. Se vuoi, cambia il **Nome nell'app Casa** (predefinito `Smarther`).
4. Premi **Salva** in fondo alla finestra. Homebridge si riavvia.

## 3. Collega il termostato

Il termostato ha una password locale, chiamata PswOpen, creata quando è stato configurato la prima volta con l'app BTicino. Quasi nessuno la conosce: è conservata nel tuo account BTicino. Riapri la pagina di configurazione e, in **Collega il termostato**, scegli uno dei due modi.

### Accedi con l'account BTicino (consigliato)

1. Scrivi l'e-mail e la password che usi nell'app BTicino Thermostat.
2. Premi **Accedi e recupera**.
3. Se l'account ha più termostati, scegli il tuo con **Usa questo termostato**. La pagina mostra la parte finale dell'indirizzo MAC di ciascuno per distinguerli.

La pagina legge la password una volta, la salva sul computer di Homebridge e si collega. E-mail e password dell'account servono solo per quella richiesta e non vengono mai salvate. La richiesta va a un servizio BTicino **non ufficiale**, che potrebbe cambiare; se smette di funzionare, usa l'altro modo.

Risposte possibili:

| Messaggio | Cosa fare |
| --- | --- |
| Accesso rifiutato | Controlla e-mail e password, quelle dell'app BTicino. |
| Account temporaneamente bloccato | Aspetta il tempo indicato prima di riprovare. I tentativi nel frattempo possono allungare il blocco. |
| Password scaduta / l'account richiede attenzione | Apri prima l'app BTicino e segui quello che chiede. |
| Nessun termostato con una password | L'account non possiede un termostato di questo tipo, oppure il cloud non ha la sua password. Usa l'account con cui è stato configurato il termostato. |
| Il cloud BTicino non è raggiungibile | Controlla la connessione a internet del computer di Homebridge, o riprova più tardi. |

### Scrivi la password a mano

Se conosci già la password, apri **Ho già la password locale**, scrivila e premi **Salva**.

### Quando la password cambia

Un reset del termostato crea una nuova password. Il plugin allora non riesce a collegarsi, e la pagina di configurazione e il log dicono che il termostato ha rifiutato la password. Accedi di nuovo per recuperare quella nuova.

## 4. Opzioni

Due gruppi nella pagina di configurazione, **Nell'app Casa** e **Avanzate**. Le modifiche si applicano premendo **Salva** in fondo alla finestra; poi Homebridge si riavvia.

| Opzione | Predefinito | Significato |
| --- | --- | --- |
| Programma settimanale nell'app Casa | come modo "Auto" | Il programma settimanale è il modo "Auto" dell'app Casa, oppure un interruttore "Programma" separato. |
| Una temperatura impostata dall'app Casa dura | fino al prossimo cambio del programma | Come propone l'app BTicino: fino al prossimo cambio di livello del programma attivo. Oppure fino a nuovo comando, o per un tempo fisso (da 15 minuti a 24 ore). |
| Consenti il cambio di stagione dall'app Casa | no | Permette all'app Casa di passare tra riscaldamento e raffrescamento. **Solo per impianti che scaldano e raffrescano con questo termostato**: con una semplice caldaia, il raffrescamento accenderebbe la caldaia. |
| Mostra un sensore di umidità separato | sì | L'umidità c'è anche nel termostato; il sensore la mostra in un riquadro a sé. |
| Interruttori Boost | 30, 60, 90 | Quali interruttori Boost mostrare. |
| Interruttori dei programmi | nessuno | Un interruttore per ogni programma settimanale che scegli, con il nome dell'app BTicino. L'elenco compare quando il plugin ha letto i programmi dal termostato. |
| Un interruttore «Spento fino al prossimo cambio» | no | Spento fino al prossimo cambio di livello del programma, come propone l'app BTicino. |
| Porta | 40000 | Lasciala vuota, a meno che il tuo termostato non ne usi un'altra. |

Le stesse opzioni ci sono nel modulo delle impostazioni di Homebridge e in `config.json`; per le chiavi vedi il [README del plugin](../../packages/homebridge-plugin/README.md#configuration), in inglese.

## 5. Il resto della pagina

Una volta collegato, la pagina funziona anche da piccolo pannello di controllo, con le stesse scelte dell'app BTicino:

- **Termostato**: temperatura e umidità della stanza, modo e sua fine, temperatura impostata, se l'impianto è in funzione, il prossimo cambio di livello.
- **Comandi**: temperatura manuale fino a un giorno e un'ora a scelta (fino a 10 giorni dopo) o fino a nuovo comando; boost per 30, 60 o 90 minuti; spento, o spento fino a un'ora a scelta; ritorno al programma; la stagione, con una conferma.
- **Programmi**: i programmi settimanali con i loro nomi, e la scelta di quello attivo.
- **Impostazioni**: livelli di temperatura, temperature di protezione, isteresi, calibrazione, opzioni del pannello, firmware e diagnostica, in sola lettura. Si cambiano nell'app BTicino o sul termostato.

Prossimo passo: [abbinamento con l'app Casa](pairing.md).
