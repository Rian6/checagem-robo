const wppconnect = require("@wppconnect-team/wppconnect");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// =====================================================
// CONFIGURAÇÕES
// =====================================================

const MONGO_URI = "mongodb://127.0.0.1:27017";
const MONGO_DATABASE = "whatsapp_bot";

const GRUPO = "RPG do bom";

const PASTA_IMAGENS = path.join(
    __dirname,
    "imagens"
);

const NOME_IMAGEM = "terca.jpg";

const DURACAO_MONITORAMENTO =
    24 * 60 * 60 * 1000;

// =====================================================
// VARIÁVEIS
// =====================================================

let mongoClient;
let db;
let reacoesCollection;

let mensagemMonitorada = null;

// ID do grupo que está sendo monitorado
let grupoMonitoradoId = null;

let reacoes = new Map();

// =====================================================
// IDENTIFICA O RESULTADO DA REAÇÃO
// =====================================================

function identificarResultado(emote) {

    // -------------------------------------------------
    // Remove modificadores de tom de pele
    //
    // 👍
    // 👍🏻
    // 👍🏼
    // 👍🏽
    // 👍🏾
    // 👍🏿
    //
    // Todos passam a ser tratados como 👍
    // -------------------------------------------------

    const emoteNormalizado =
        emote.replace(
            /[\u{1F3FB}-\u{1F3FF}]/gu,
            ""
        );

    // -------------------------------------------------
    // 👍 = DURO
    // -------------------------------------------------

    if (
        emoteNormalizado === "👍"
    ) {
        return "DURO";
    }

    // -------------------------------------------------
    // TODOS OS CORAÇÕES = MOLE
    // -------------------------------------------------

    const coracoes = [
        "❤️",
        "🧡",
        "💛",
        "💚",
        "💙",
        "💜",
        "🖤",
        "🤍",
        "🤎",
        "🩷",
        "🩵",
        "🩶"
    ];

    if (
        coracoes.includes(
            emoteNormalizado
        )
    ) {
        return "MOLE";
    }

    // -------------------------------------------------
    // OUTRAS REAÇÕES
    // -------------------------------------------------

    return null;
}

// =====================================================
// MONGODB
// =====================================================

async function conectarMongo() {

    console.log(
        "\n================================="
    );

    console.log(
        " CONECTANDO AO MONGODB"
    );

    console.log(
        "================================="
    );

    mongoClient =
        new MongoClient(
            MONGO_URI
        );

    await mongoClient.connect();

    db =
        mongoClient.db(
            MONGO_DATABASE
        );

    reacoesCollection =
        db.collection(
            "reacoes"
        );

    // -------------------------------------------------
    // Impede que o mesmo participante
    // tenha duas reações na mesma mensagem.
    // -------------------------------------------------

    await reacoesCollection.createIndex(
        {
            messageId: 1,
            participantId: 1
        },
        {
            unique: true
        }
    );

    console.log(
        `Banco: ${MONGO_DATABASE}`
    );

    console.log(
        "Coleção: reacoes"
    );

    console.log(
        "MongoDB conectado!"
    );
}

// =====================================================
// SALVAR / ATUALIZAR REAÇÃO
// =====================================================

async function salvarReacaoMongo({
    messageId,
    grupoId,
    fromMe,
    participantId,
    name,
    telefone,
    emote,
    resultado,
    timestamp
}) {

    if (!reacoesCollection) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    const agora =
        new Date();

    const resultadoMongo =
        await reacoesCollection.updateOne(
            {
                messageId:
                    messageId,

                participantId:
                    participantId
            },

            {
                $set: {
                    messageId:
                        messageId,

                    grupoId:
                        grupoId,

                    fromMe:
                        fromMe,

                    participantId:
                        participantId,

                    name:
                        name,

                    telefone:
                        telefone,

                    emote:
                        emote,

                    // NOVO
                    resultado:
                        resultado,

                    isDeleted:
                        false,

                    timestamp:
                        timestamp,

                    updatedAt:
                        agora
                },

                $setOnInsert: {
                    createdAt:
                        agora
                }
            },

            {
                upsert: true
            }
        );

    console.log(
        "💾 REAÇÃO SALVA NO MONGODB"
    );

    console.log(
        "Participante:",
        participantId
    );

    console.log(
        "Emote:",
        emote
    );

    console.log(
        "Resultado:",
        resultado ||
        "IGNORADO"
    );

    console.log(
        "Matched:",
        resultadoMongo.matchedCount
    );

    console.log(
        "Modified:",
        resultadoMongo.modifiedCount
    );

    console.log(
        "Upserted:",
        resultadoMongo.upsertedCount
    );

    return resultadoMongo;
}

// =====================================================
// DELETAR REAÇÃO
// =====================================================

async function deletarReacaoMongo(
    messageId,
    participantId
) {

    if (!reacoesCollection) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    const resultado =
        await reacoesCollection.deleteOne(
            {
                messageId:
                    messageId,

                participantId:
                    participantId
            }
        );

    if (
        resultado.deletedCount > 0
    ) {

        console.log(
            "🗑️ REAÇÃO DELETADA DO MONGODB"
        );

        console.log(
            "Participante:",
            participantId
        );

    } else {

        console.log(
            "⚠️ Reação não encontrada no MongoDB para deletar."
        );
    }

    return resultado;
}

// =====================================================
// CONTAR REAÇÕES
// =====================================================

async function contarReacoes(
    messageId
) {

    if (!reacoesCollection) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    const total =
        await reacoesCollection.countDocuments(
            {
                messageId:
                    messageId
            }
        );

    return total;
}

// =====================================================
// BUSCAR REAÇÕES
// =====================================================

async function buscarReacoes(
    messageId
) {

    if (!reacoesCollection) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    return await reacoesCollection
        .find(
            {
                messageId:
                    messageId
            }
        )
        .sort(
            {
                timestamp: 1
            }
        )
        .toArray();
}

// =====================================================
// ENVIA NOTIFICAÇÃO DA REAÇÃO
// =====================================================

async function enviarNotificacaoReacao(
    client,
    emote,
    name,
    timestamp
) {

    // =================================================
    // IDENTIFICA O RESULTADO
    // =================================================

    const resultado =
        identificarResultado(
            emote
        );

    // -------------------------------------------------
    // Outras reações são ignoradas
    // -------------------------------------------------

    if (!resultado) {

        console.log(
            `⏭️ Reação ${emote} ignorada.`
        );

        return;
    }

    // =================================================
    // VERIFICA GRUPO
    // =================================================

    if (!grupoMonitoradoId) {

        console.log(
            "⚠️ ID do grupo monitorado não disponível."
        );

        return;
    }

    // =================================================
    // HORÁRIO DA REAÇÃO
    // =================================================

    const dataReacao =
        timestamp
            ? new Date(
                timestamp * 1000
            )
            : new Date();

    const hora =
        dataReacao.toLocaleTimeString(
            "pt-BR",
            {
                hour:
                    "2-digit",

                minute:
                    "2-digit"
            }
        );

    // =================================================
    // NOME
    // =================================================

    const nomePessoa =
        name ||
        "Participante";

    // =================================================
    // ESTADO
    // =================================================

    const estado =
        resultado === "DURO"
            ? "de pau duro"
            : "de pau mole";

    // =================================================
    // MENSAGEM
    // =================================================

    const mensagemBot =
        `🤖 *BOT DA CHECAGEM:*\n\n` +
        `Às ${hora}, *${nomePessoa}* estava ${estado}, computando resultado.`;

    // =================================================
    // ENVIA
    // =================================================

    try {

        console.log(
            "\n🤖 ENVIANDO NOTIFICAÇÃO..."
        );

        console.log(
            mensagemBot
        );

        await client.sendText(
            grupoMonitoradoId,
            mensagemBot
        );

        console.log(
            "✅ Notificação enviada ao grupo!"
        );

    } catch (erro) {

        console.error(
            "❌ Erro ao enviar notificação:",
            erro
        );
    }
}

// =====================================================
// INICIA O BOT
// =====================================================

async function iniciar() {

    try {

        await conectarMongo();

        console.log(
            "\nIniciando WhatsApp..."
        );

        wppconnect
            .create(
                {
                    session:
                        "daily-bot",

                    catchQR:
                        (
                            base64Qr,
                            asciiQR
                        ) => {

                            console.log(
                                asciiQR
                            );
                        },

                    statusFind:
                        (
                            status
                        ) => {

                            console.log(
                                "Status:",
                                status
                            );
                        }
                }
            )

            .then(
                start
            )

            .catch(
                (erro) => {

                    console.error(
                        "❌ Erro no WhatsApp:",
                        erro
                    );
                }
            );

    } catch (erro) {

        console.error(
            "\n❌ Erro ao iniciar:",
            erro
        );

        process.exit(
            1
        );
    }
}

iniciar();

// =====================================================
// START
// =====================================================

async function start(
    client
) {

    console.log(
        "\n================================="
    );

    console.log(
        " WhatsApp Daily Reaction Bot"
    );

    console.log(
        "=================================\n"
    );

    console.log(
        "WhatsApp conectado!"
    );

    // -------------------------------------------------
    // Começa a escutar reações
    // -------------------------------------------------

    configurarMonitoramentoDeReacoes(
        client
    );

    // -------------------------------------------------
    // Aguarda sincronização
    // -------------------------------------------------

    await esperarWhatsAppPronto(
        client
    );

    console.log(
        "WhatsApp sincronizado!"
    );

    // -------------------------------------------------
    // Procura grupo
    // -------------------------------------------------

    const grupo =
        await encontrarGrupo(
            client
        );

    if (!grupo) {

        console.error(
            `Grupo "${GRUPO}" não encontrado.`
        );

        return;
    }

    const grupoId =
        grupo.id._serialized;

    // Guarda globalmente
    grupoMonitoradoId =
        grupoId;

    console.log(
        `Grupo encontrado: ${grupo.name}`
    );

    console.log(
        `ID: ${grupoId}`
    );

    // =================================================
    // IMAGEM
    // =================================================

    const imagem =
        path.join(
            PASTA_IMAGENS,
            NOME_IMAGEM
        );

    if (
        !fs.existsSync(
            imagem
        )
    ) {

        console.error(
            `Imagem não encontrada: ${imagem}`
        );

        return;
    }

    // =================================================
    // DATA
    // =================================================

    const agora =
        new Date();

    const data =
        agora.toLocaleDateString(
            "pt-BR",
            {
                day:
                    "2-digit",

                month:
                    "2-digit",

                year:
                    "numeric"
            }
        );

    // =================================================
    // TEXTO DA CHECAGEM
    // =================================================

    const legenda =
        `🍆 *CHECAGEM DE PAU 2.0*\n\n` +
        `📅 *Data:* ${data}\n\n` +
        `🚨 *Está na hora da checagem!*\n\n` +
        `Hoje vamos acompanhar as reações para identificar possíveis sinais de predisposição ao amolecimento durante o período de monitoramento.\n\n` +
        `⏱️ *Monitoramento:* próximas 24 horas\n\n` +
        `👉 Reaja à imagem abaixo de acordo com a situação atual.\n\n` +
        `📈 Todas as reações serão registradas e contabilizadas durante o período.\n\n` +
        `🍆 *Participe. Seu pau agradece.*\n\n` +
        `🔔 *A checagem ficará aberta por 24 horas.*`;

    console.log(
        "\n================================="
    );

    console.log(
        " ENVIANDO CHECAGEM"
    );

    console.log(
        "================================="
    );

    console.log(
        "Imagem:",
        imagem
    );

    console.log(
        "Data:",
        data
    );

    console.log(
        "\nEnviando imagem + texto..."
    );

    // =================================================
    // ENVIA IMAGEM + TEXTO
    // =================================================

    const mensagem =
        await client.sendImage(
            grupoId,
            imagem,
            NOME_IMAGEM,
            legenda
        );

    if (!mensagem) {

        console.error(
            "O WhatsApp não retornou a mensagem."
        );

        return;
    }

    const messageId =
        mensagem.id?._serialized ||
        mensagem.id;

    console.log(
        "\n✅ Imagem + texto enviados!"
    );

    console.log(
        "ID da mensagem:",
        messageId
    );

    // =================================================
    // COMEÇA MONITORAMENTO
    // =================================================

    await iniciarMonitoramento(
        mensagem,
        grupoId
    );
}

// =====================================================
// EVENTO DE REAÇÕES
// =====================================================

function configurarMonitoramentoDeReacoes(
    client
) {

    client.onReactionMessage(
        async (reaction) => {

            try {

                console.log(
                    "\n=============================="
                );

                console.log(
                    "🔥 REAÇÃO RECEBIDA!"
                );

                console.log(
                    "=============================="
                );

                // =================================================
                // VERIFICA SE EXISTE MENSAGEM MONITORADA
                // =================================================

                if (!mensagemMonitorada) {

                    console.log(
                        "⚠️ Nenhuma mensagem está sendo monitorada."
                    );

                    return;
                }

                // =================================================
                // IDS
                // =================================================

                const idMensagemReagida =
                    reaction.msgId?._serialized ||
                    reaction.msgId;

                const idMensagemMonitorada =
                    mensagemMonitorada
                        .id?._serialized ||
                    mensagemMonitorada.id;

                console.log(
                    "Mensagem reagida:",
                    idMensagemReagida
                );

                console.log(
                    "Mensagem monitorada:",
                    idMensagemMonitorada
                );

                // =================================================
                // VERIFICA SE É A MENSAGEM CERTA
                // =================================================

                if (
                    idMensagemReagida !==
                    idMensagemMonitorada
                ) {

                    console.log(
                        "⚠️ Reação não pertence à mensagem monitorada."
                    );

                    return;
                }

                // =================================================
                // PARTICIPANTE
                // =================================================

                const participantId =
                    reaction.id?.participant ||
                    reaction.author ||
                    reaction.from;

                if (!participantId) {

                    console.log(
                        "⚠️ Não foi possível identificar o participante."
                    );

                    return;
                }

                console.log(
                    "Participante:",
                    participantId
                );

                // =================================================
                // EMOTE
                // =================================================

                const emote =
                    reaction.reactionText ||
                    "";

                const isDeleted =
                    emote === "";

                console.log(
                    "Emote:",
                    isDeleted
                        ? "(removido)"
                        : emote
                );

                // =================================================
                // IDENTIFICA RESULTADO
                // =================================================

                const resultado =
                    isDeleted
                        ? null
                        : identificarResultado(
                            emote
                        );

                console.log(
                    "Resultado:",
                    resultado ||
                    "IGNORADO"
                );

                // =================================================
                // DADOS DO USUÁRIO
                // =================================================

                let name = "";
                let telefone = "";

                try {

                    const contato =
                        await client.getContact(
                            participantId
                        );

                    if (contato) {

                        name =
                            contato.name ||
                            contato.pushname ||
                            contato.shortName ||
                            "";

                        telefone =
                            contato.id?.user ||
                            contato.number ||
                            contato.userid ||
                            "";
                    }

                } catch (erro) {

                    console.log(
                        "⚠️ Não foi possível buscar os dados do contato:",
                        erro.message
                    );
                }

                // =================================================
                // FALLBACK PARA NOME
                // =================================================

                if (!name) {

                    try {

                        const mensagem =
                            await client.getMessageById(
                                idMensagemMonitorada
                            );

                        if (
                            mensagem?.sender
                        ) {

                            name =
                                mensagem.sender.pushname ||
                                mensagem.sender.formattedName ||
                                "";
                        }

                    } catch (erro) {

                        console.log(
                            "⚠️ Não foi possível obter o sender:",
                            erro.message
                        );
                    }
                }

                // =================================================
                // @LID NÃO É TELEFONE
                // =================================================

                if (
                    telefone &&
                    telefone.includes("@")
                ) {

                    telefone = "";
                }

                // =================================================
                // TIMESTAMP
                // =================================================

                const timestamp =
                    reaction.timestamp ||
                    Math.floor(
                        Date.now() / 1000
                    );

                // =================================================
                // REAÇÃO REMOVIDA
                // =================================================

                if (isDeleted) {

                    console.log(
                        "\n🗑️ PROCESSANDO REMOÇÃO..."
                    );

                    // -------------------------------------------------
                    // Remove do Mongo
                    // -------------------------------------------------

                    await deletarReacaoMongo(
                        idMensagemMonitorada,
                        participantId
                    );

                    // -------------------------------------------------
                    // Remove da memória
                    // -------------------------------------------------

                    reacoes.delete(
                        participantId
                    );

                    console.log(
                        "Memória local atualizada."
                    );
                }

                // =================================================
                // REAÇÃO ADICIONADA / ALTERADA
                // =================================================

                else {

                    console.log(
                        "\n💾 PROCESSANDO REAÇÃO..."
                    );

                    const dadosReacao = {

                        messageId:
                            idMensagemMonitorada,

                        grupoId:
                            mensagemMonitorada
                                .id
                                ?.remote ||
                            grupoMonitoradoId ||
                            "",

                        fromMe:
                            reaction.id?.fromMe ??
                            false,

                        participantId:
                            participantId,

                        name:
                            name,

                        telefone:
                            telefone,

                        emote:
                            emote,

                        // NOVO
                        resultado:
                            resultado,

                        timestamp:
                            timestamp
                    };

                    // =================================================
                    // SALVA / ATUALIZA MONGO
                    // =================================================

                    await salvarReacaoMongo(
                        dadosReacao
                    );

                    // =================================================
                    // ATUALIZA MEMÓRIA
                    // =================================================

                    reacoes.set(
                        participantId,
                        {
                            fromMe:
                                dadosReacao.fromMe,

                            participantId:
                                participantId,

                            name:
                                name,

                            telefone:
                                telefone,

                            emote:
                                emote,

                            // NOVO
                            resultado:
                                resultado,

                            isDeleted:
                                false,

                            timestamp:
                                timestamp,

                            total:
                                0
                        }
                    );

                    console.log(
                        "Memória local atualizada."
                    );

                    // =================================================
                    // ENVIA NOTIFICAÇÃO
                    // =================================================

                    await enviarNotificacaoReacao(
                        client,
                        emote,
                        name,
                        timestamp
                    );
                }

                // =================================================
                // TOTAL VINDO DO MONGODB
                // =================================================

                const total =
                    await contarReacoes(
                        idMensagemMonitorada
                    );

                // =================================================
                // ATUALIZA TOTAL LOCAL
                // =================================================

                for (
                    const registro
                    of reacoes.values()
                ) {

                    registro.total =
                        total;
                }

                // =================================================
                // REGISTRO ATUAL
                // =================================================

                const registroAtual =
                    reacoes.get(
                        participantId
                    );

                // =================================================
                // JSON
                // =================================================

                console.log(
                    "\n===== JSON DA REAÇÃO ====="
                );

                console.log(
                    JSON.stringify(
                        registroAtual ||
                        {
                            fromMe:
                                reaction.id?.fromMe ??
                                false,

                            participantId:
                                participantId,

                            name:
                                name,

                            telefone:
                                telefone,

                            emote:
                                emote,

                            resultado:
                                resultado,

                            isDeleted:
                                isDeleted,

                            timestamp:
                                timestamp,

                            total:
                                total
                        },
                        null,
                        2
                    )
                );

                // =================================================
                // REAÇÕES DO MONGO
                // =================================================

                const reacoesMongo =
                    await buscarReacoes(
                        idMensagemMonitorada
                    );

                console.log(
                    "\n===== REAÇÕES NO MONGODB ====="
                );

                console.log(
                    JSON.stringify(
                        reacoesMongo,
                        null,
                        2
                    )
                );

                console.log(
                    "\nTotal no MongoDB:",
                    total
                );

                console.log(
                    "==============================\n"
                );

            } catch (erro) {

                console.error(
                    "\n❌ ERRO AO PROCESSAR REAÇÃO:"
                );

                console.error(
                    erro
                );
            }
        }
    );
}

// =====================================================
// INICIA MONITORAMENTO
// =====================================================

async function iniciarMonitoramento(
    mensagem,
    grupoId
) {

    mensagemMonitorada =
        mensagem;

    grupoMonitoradoId =
        grupoId;

    reacoes.clear();

    const id =
        mensagem.id?._serialized ||
        mensagem.id;

    console.log(
        "\n================================="
    );

    console.log(
        " MONITORAMENTO INICIADO"
    );

    console.log(
        "================================="
    );

    console.log(
        "Mensagem:",
        id
    );

    console.log(
        "Grupo:",
        grupoId
    );

    console.log(
        "Duração: 24 horas"
    );

    console.log(
        "Início:",
        new Date().toLocaleString(
            "pt-BR"
        )
    );

    console.log(
        "Fim:",
        new Date(
            Date.now() +
            DURACAO_MONITORAMENTO
        ).toLocaleString(
            "pt-BR"
        )
    );

    // =================================================
    // LIMPA REAÇÕES ANTIGAS DA MESMA MENSAGEM
    // =================================================

    await reacoesCollection.deleteMany(
        {
            messageId:
                id
        }
    );

    console.log(
        "Banco preparado para o novo monitoramento."
    );

    // =================================================
    // 24 HORAS
    // =================================================

    setTimeout(
        async () => {

            try {

                console.log(
                    "\n================================="
                );

                console.log(
                    " MONITORAMENTO ENCERRADO"
                );

                console.log(
                    "================================="
                );

                console.log(
                    "Data:",
                    new Date().toLocaleString(
                        "pt-BR"
                    )
                );

                await mostrarReacoes();

                mensagemMonitorada =
                    null;

                grupoMonitoradoId =
                    null;

                reacoes.clear();

            } catch (erro) {

                console.error(
                    "❌ Erro ao encerrar monitoramento:",
                    erro
                );
            }

        },
        DURACAO_MONITORAMENTO
    );
}

// =====================================================
// MOSTRA REAÇÕES
// =====================================================

async function mostrarReacoes() {

    console.log(
        "\n===== REAÇÕES ATUAIS ====="
    );

    if (!mensagemMonitorada) {

        console.log(
            "Nenhuma mensagem sendo monitorada."
        );

        return;
    }

    const messageId =
        mensagemMonitorada
            .id?._serialized ||
        mensagemMonitorada.id;

    const registros =
        await buscarReacoes(
            messageId
        );

    if (
        registros.length === 0
    ) {

        console.log(
            "Nenhuma reação registrada."
        );

        return;
    }

    for (
        const registro
        of registros
    ) {

        console.log(
            `${registro.emote} ${
                registro.name ||
                registro.participantId
            } → ${
                registro.resultado ||
                "IGNORADO"
            }`
        );
    }

    console.log(
        `Total: ${registros.length}`
    );

    console.log(
        "==========================\n"
    );
}

// =====================================================
// AGUARDA WHATSAPP PRONTO
// =====================================================

async function esperarWhatsAppPronto(
    client
) {

    console.log(
        "Aguardando WhatsApp carregar os chats..."
    );

    for (
        let tentativa = 1;
        tentativa <= 30;
        tentativa++
    ) {

        try {

            const estado =
                await client.getConnectionState();

            console.log(
                `Tentativa ${tentativa}/30 - Estado: ${estado}`
            );

            if (
                estado === "CONNECTED"
            ) {

                try {

                    const chats =
                        await client.listChats();

                    if (
                        chats &&
                        chats.length > 0
                    ) {

                        console.log(
                            `WhatsApp pronto! ${chats.length} chats carregados.`
                        );

                        return;
                    }

                    console.log(
                        "Conectado, mas os chats ainda não foram carregados..."
                    );

                } catch (erro) {

                    console.log(
                        "Chats ainda não disponíveis..."
                    );
                }
            }

        } catch (erro) {

            console.log(
                "Aguardando WhatsApp..."
            );
        }

        await esperar(
            3000
        );
    }

    throw new Error(
        "WhatsApp conectou, mas os chats não foram carregados."
    );
}

// =====================================================
// ENCONTRA GRUPO
// =====================================================

async function encontrarGrupo(
    client
) {

    console.log(
        `Procurando grupo "${GRUPO}"...`
    );

    const chats =
        await client.listChats();

    console.log(
        `Total de chats: ${chats.length}`
    );

    const grupos =
        chats.filter(
            chat =>
                chat.isGroup
        );

    console.log(
        `Total de grupos: ${grupos.length}`
    );

    const alvo =
        GRUPO
            .trim()
            .toLowerCase();

    const grupo =
        grupos.find(
            grupo => {

                const nome =
                    (
                        grupo.name ||
                        ""
                    )
                        .trim()
                        .toLowerCase();

                return nome === alvo;
            }
        );

    if (grupo) {

        console.log(
            "GRUPO ENCONTRADO!"
        );

        return grupo;
    }

    return null;
}

// =====================================================
// SLEEP
// =====================================================

function esperar(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}