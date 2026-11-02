# Abbinamento con l'app Casa

*[English](../en/pairing.md)*

Dopo la [configurazione](setup.md), aggiungi il bridge di Homebridge all'app Casa. Il termostato arriva insieme al bridge.

## Abbina

1. Con l'iPhone o l'iPad, collegati alla stessa rete del computer di Homebridge.
2. Nell'interfaccia di Homebridge, la pagina **Stato** mostra un codice QR e un codice di abbinamento di otto cifre.
3. Nell'app Casa tocca **+**, poi **Aggiungi accessorio**, e inquadra il codice QR. Senza fotocamera scegli **Altre opzioni…** e scrivi il codice.
4. L'app Casa avvisa che l'accessorio non è certificato: scegli **Aggiungi comunque**. I bridge di Homebridge non sono mai certificati da Apple.
5. Scegli una stanza per il bridge e per il termostato, e conferma i nomi.

Il codice di abbinamento funziona solo finché il bridge non è abbinato. Tienilo comunque riservato: è nei backup di Homebridge e nel suo log.

## Cosa ottieni

Un accessorio, con il nome impostato nelle impostazioni del plugin, e questi servizi:

- **Termostato**: temperatura e umidità della stanza, temperatura impostata e i modi Spento, Caldo (o Freddo) e Auto. Vedi [funzioni](features.md) per cosa fa ciascun modo sul termostato.
- **Umidità**: un sensore separato, se non l'hai disattivato.
- **Boost 30 / 60 / 90 min**: interruttori, se non li hai disattivati.
- Interruttori facoltativi, se li hai scelti: **Programma**, uno per ogni programma settimanale, **Spento fino al prossimo cambio**.

I nomi sono nella lingua scelta nelle impostazioni del plugin. Per hindi e thai l'app Casa riceve i nomi inglesi, perché HomeKit non accetta i segni vocalici di quelle scritture; puoi rinominare i servizi nell'app Casa.

Se dopo l'abbinamento un servizio ha un nome generico come "Interruttore 2", riavvia Homebridge: il plugin rimette i suoi nomi a ogni avvio.

## Fuori casa

L'app Casa raggiunge Homebridge solo sulla rete di casa, a meno che tu non abbia un hub domestico Apple (Apple TV o HomePod), che fa da tramite con il servizio cifrato di Apple. Questo progetto non aggiunge un accesso remoto suo. Fuori casa e senza hub, usa l'app BTicino.

## Sostituire un bridge

Se sposti Homebridge su un altro computer, o lo riconfiguri da zero, prima rimuovi il vecchio bridge dall'app Casa (nell'app Casa apri le impostazioni del bridge e scegli **Rimuovi bridge**), poi abbina quello nuovo. Altrimenti l'app Casa mostra un secondo termostato irraggiungibile.

Per abbinare di nuovo lo stesso bridge, per esempio dopo averlo rimosso per errore, prima azzera il suo abbinamento nelle impostazioni dell'interfaccia di Homebridge.
