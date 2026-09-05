const wppconnect = require("@wppconnect-team/wppconnect");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// =====================================================
// CONFIGURAÇÃO
// =====================================================

const CONFIG_PATH = path.join(__dirname, "config.json");

const MONGO_URI = "mongodb://127.0.0.1:27017";
const MONGO_DATABASE = "whatsapp_bot";
const MONGO_COLLECTION = "reacoes";
const MONGO_ENVIOS_COLLECTION = "envios";

const dias = [
    "domingo.jpg",
    "segunda.jpg",
    "terca.jpg",
    "quarta.jpg",
    "quinta.jpg",
    "sexta.png",
    "sabado.jpg"
];

const DURACAO_MONITORAMENTO = 24 * 60 * 60 * 1000;

// =====================================================
// CONFIG DINÂMICA
// =====================================================

let config = {
    grupos: [],
    horario_envio: "08:00",
    pasta_imagens: "imagens",
    intervalo_reacao: 2000
};

// =====================================================
// MEMÓRIA
// =====================================================

const ultimosEnvios = new Map();
const monitoramentos = new Map();

// =====================================================
// MONGODB
// =====================================================

let mongoClient;
let db;
let reacoesCollection;
let enviosCollection;

// =====================================================
// UTILIDADES
// =====================================================

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizarNomeGrupo(nome) {
    return (nome || "")
        .trim()
        .toLowerCase();
}

function obterNomeImagemAtual(data = new Date()) {
    return dias[data.getDay()];
}

function dataAtual() {
    return new Date().toLocaleDateString("pt-BR");
}

function chaveDataLocal(data) {
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, "0");
    const dia = String(data.getDate()).padStart(2, "0");

    return `${ano}-${mes}-${dia}`;
}

function horarioEmData(dataBase, horario = config.horario_envio) {
    const [hora, minuto] = String(horario)
        .split(":")
        .map(Number);

    const data = new Date(dataBase);

    data.setHours(
        Number.isFinite(hora) ? hora : 8,
        Number.isFinite(minuto) ? minuto : 0,
        0,
        0
    );

    return data;
}

// =====================================================
// CICLO DA CHECAGEM
// =====================================================

/*
 * Exemplo horário = 08:00
 *
 * 05/09 15:00
 * ciclo = 05/09 08:00 até 06/09 08:00
 *
 * 06/09 05:00
 * ainda pertence ao ciclo iniciado em 05/09 08:00
 *
 * Isso permite reiniciar o bot antes do próximo horário
 * e recuperar a mensagem anterior.
 */

function obterCicloAtivo(agora = new Date()) {
    const horarioHoje = horarioEmData(
        agora,
        config.horario_envio
    );

    let inicio;

    if (agora >= horarioHoje) {
        inicio = horarioHoje;
    } else {
        const ontem = new Date(agora);

        ontem.setDate(
            ontem.getDate() - 1
        );

        inicio = horarioEmData(
            ontem,
            config.horario_envio
        );
    }

    const fim = new Date(inicio);

    fim.setDate(
        fim.getDate() + 1
    );

    return {
        ciclo: chaveDataLocal(inicio),
        inicio,
        fim
    };
}

// =====================================================
// CONFIG.JSON
// =====================================================

function carregarConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            console.error(
                `❌ Arquivo config.json não encontrado: ${CONFIG_PATH}`
            );

            return;
        }

        const conteudo = fs.readFileSync(
            CONFIG_PATH,
            "utf8"
        );

        const novoConfig = JSON.parse(conteudo);

        let grupos = [];

        if (Array.isArray(novoConfig.grupos)) {
            grupos = novoConfig.grupos;
        } else if (typeof novoConfig.grupo === "string") {
            grupos = [novoConfig.grupo];
        }

        grupos = grupos
            .filter(
                grupo =>
                    typeof grupo === "string" &&
                    grupo.trim() !== ""
            )
            .map(
                grupo =>
                    grupo.trim()
            );

        config = {
            ...config,
            ...novoConfig,
            grupos
        };

        console.log("\n=================================");
        console.log(" CONFIGURAÇÃO ATUALIZADA");
        console.log("=================================");
        console.log("Grupos:", config.grupos);
        console.log("Horário:", config.horario_envio);
        console.log("Pasta imagens:", config.pasta_imagens);
        console.log(
            "Intervalo reação:",
            config.intervalo_reacao,
            "ms"
        );
        console.log("=================================\n");

    } catch (erro) {
        console.error(
            "❌ Erro ao carregar config.json:",
            erro.message
        );
    }
}

// =====================================================
// MONITORA CONFIG.JSON
// =====================================================

function monitorarArquivoConfig() {
    fs.watchFile(
        CONFIG_PATH,
        {
            interval: 1000
        },
        (curr, prev) => {
            if (curr.mtimeMs !== prev.mtimeMs) {
                console.log(
                    "\n🔄 config.json alterado!"
                );

                carregarConfig();
            }
        }
    );

    console.log(
        "👀 Monitorando alterações no config.json..."
    );
}

// =====================================================
// IDENTIFICA RESULTADO
// =====================================================

function identificarResultado(emote) {
    if (!emote) {
        return null;
    }

    const emoteNormalizado =
        emote.replace(
            /[\u{1F3FB}-\u{1F3FF}]/gu,
            ""
        );

    // 👍 = DURO

    if (emoteNormalizado === "👍") {
        return "DURO";
    }

    // CORAÇÕES = MOLE

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

    if (coracoes.includes(emoteNormalizado)) {
        return "MOLE";
    }

    return null;
}

// =====================================================
// CONECTA MONGODB
// =====================================================

async function conectarMongo() {
    console.log("\n=================================");
    console.log(" CONECTANDO AO MONGODB");
    console.log("=================================");

    mongoClient = new MongoClient(
        MONGO_URI
    );

    await mongoClient.connect();

    db = mongoClient.db(
        MONGO_DATABASE
    );

    reacoesCollection = db.collection(
        MONGO_COLLECTION
    );

    enviosCollection = db.collection(
        MONGO_ENVIOS_COLLECTION
    );

    // =================================================
    // ÍNDICES REAÇÕES
    // =================================================

    await reacoesCollection.createIndex(
        {
            messageId: 1,
            participantId: 1
        },
        {
            unique: true
        }
    );

    // =================================================
    // ÍNDICES ENVIOS
    // =================================================

    await enviosCollection.createIndex(
        {
            grupoId: 1,
            ciclo: 1
        },
        {
            unique: true
        }
    );

    await enviosCollection.createIndex(
        {
            enviadoEm: -1
        }
    );

    console.log(
        `Banco: ${MONGO_DATABASE}`
    );

    console.log(
        `Coleção reações: ${MONGO_COLLECTION}`
    );

    console.log(
        `Coleção envios: ${MONGO_ENVIOS_COLLECTION}`
    );

    console.log(
        "MongoDB conectado!"
    );
}

// =====================================================
// SALVAR REAÇÃO
// =====================================================

async function salvarReacaoMongo({
    messageId,
    grupoId,
    grupoNome,
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

    const agora = new Date();

    const resultadoMongo =
        await reacoesCollection.updateOne(
            {
                messageId,
                participantId
            },
            {
                $set: {
                    messageId,
                    grupoId,
                    grupoNome,
                    fromMe,
                    participantId,
                    name,
                    telefone,
                    emote,
                    resultado,
                    isDeleted: false,
                    timestamp,
                    updatedAt: agora
                },

                $setOnInsert: {
                    createdAt: agora
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
        "Grupo:",
        grupoNome
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
        resultado || "IGNORADO"
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
        await reacoesCollection.deleteOne({
            messageId,
            participantId
        });

    if (resultado.deletedCount > 0) {
        console.log(
            "🗑️ REAÇÃO DELETADA DO MONGODB"
        );
    } else {
        console.log(
            "⚠️ Reação não encontrada no MongoDB."
        );
    }

    return resultado;
}

// =====================================================
// CONTAR REAÇÕES
// =====================================================

async function contarReacoes(messageId) {
    if (!reacoesCollection) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    return await reacoesCollection.countDocuments({
        messageId
    });
}

// =====================================================
// BUSCAR REAÇÕES
// =====================================================

async function buscarReacoes(messageId) {
    if (!reacoesCollection) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    return await reacoesCollection
        .find({
            messageId
        })
        .sort({
            timestamp: 1
        })
        .toArray();
}

// =====================================================
// PERSISTÊNCIA DOS ENVIOS
// =====================================================

async function salvarEnvioMongo({
    messageId,
    grupoId,
    grupoNome,
    ciclo,
    enviadoEm
}) {
    if (!enviosCollection) {
        throw new Error(
            "Coleção de envios ainda não disponível."
        );
    }

    await enviosCollection.updateOne(
        {
            grupoId,
            ciclo
        },
        {
            $set: {
                messageId,
                grupoId,
                grupoNome,
                ciclo,
                enviadoEm,
                atualizadoEm: new Date()
            },

            $setOnInsert: {
                criadoEm: new Date()
            }
        },
        {
            upsert: true
        }
    );

    console.log(
        `💾 Envio persistido: ${grupoNome} / ${ciclo}`
    );
}

async function buscarEnvioDoCiclo(
    grupoId,
    ciclo
) {
    if (!enviosCollection) {
        return null;
    }

    return await enviosCollection.findOne({
        grupoId,
        ciclo
    });
}

// =====================================================
// MIGRAÇÃO DA VERSÃO ANTIGA
// =====================================================

/*
 * Antes dessa versão não existia coleção "envios".
 *
 * Se já houver reação no Mongo para a mensagem antiga,
 * conseguimos recuperar o messageId por ela.
 */

async function buscarEnvioLegadoPelasReacoes({
    grupoId,
    grupoNome,
    ciclo,
    inicio,
    fim
}) {
    const registro =
        await reacoesCollection.findOne(
            {
                grupoId,

                $or: [
                    {
                        createdAt: {
                            $gte: inicio,
                            $lt: fim
                        }
                    },

                    {
                        updatedAt: {
                            $gte: inicio,
                            $lt: fim
                        }
                    }
                ]
            },
            {
                sort: {
                    createdAt: -1,
                    updatedAt: -1
                }
            }
        );

    if (!registro?.messageId) {
        return null;
    }

    const envio = {
        messageId:
            registro.messageId,

        grupoId,

        grupoNome:
            registro.grupoNome ||
            grupoNome,

        ciclo,

        enviadoEm:
            registro.createdAt ||
            inicio
    };

    await salvarEnvioMongo(
        envio
    );

    console.log(
        `♻️ Envio antigo recuperado pelas reações: ${envio.messageId}`
    );

    return envio;
}

// =====================================================
// CARREGA REAÇÕES DO MONGO PARA MEMÓRIA
// =====================================================

async function carregarReacoesNoMonitoramento(
    monitoramento
) {
    const registros =
        await buscarReacoes(
            monitoramento.messageId
        );

    for (const registro of registros) {
        monitoramento.reacoes.set(
            registro.participantId,
            {
                fromMe:
                    registro.fromMe ?? false,

                participantId:
                    registro.participantId,

                name:
                    registro.name || "",

                telefone:
                    registro.telefone || "",

                emote:
                    registro.emote || "",

                resultado:
                    registro.resultado || null,

                isDeleted:
                    registro.isDeleted ?? false,

                timestamp:
                    registro.timestamp,

                total:
                    registros.length
            }
        );
    }

    return registros.length;
}

// =====================================================
// NOTIFICAÇÃO DA REAÇÃO
// =====================================================

async function enviarNotificacaoReacao({
    client,
    grupoOrigemNome,
    emote,
    name,
    timestamp
}) {
    try {
        const configAtual = config;

        if (
            !configAtual.grupos ||
            !Array.isArray(configAtual.grupos) ||
            configAtual.grupos.length === 0
        ) {
            console.log(
                "⚠️ Nenhum grupo participante configurado."
            );

            return;
        }

        const resultado =
            identificarResultado(emote);

        if (!resultado) {
            return;
        }

        let estado;

        if (resultado === "DURO") {
            estado = "de pau duro";
        } else if (resultado === "MOLE") {
            estado = "de pau mole";
        } else {
            return;
        }

        const data = timestamp
            ? new Date(timestamp)
            : new Date();

        const hora =
            data.toLocaleTimeString(
                "pt-BR",
                {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false
                }
            );

        const nomePessoa =
            name && name.trim()
                ? name.trim()
                : "Pessoa desconhecida";

        const mensagemBot =
            `🤖 *BOT DA CHECAGEM*\n\n` +
            `Às *${hora}*, *${nomePessoa}* (${grupoOrigemNome}) ` +
            `reportou que estava ${estado} 🍆\n\n` +
            `✅ Voto registrado com sucesso!`;

        console.log(
            "\n📢 ENVIANDO RESULTADO PARA TODOS OS GRUPOS:"
        );

        console.log(
            mensagemBot
        );

        const gruposWhatsApp =
            await encontrarGrupos(
                client
            );

        for (
            const nomeGrupo
            of configAtual.grupos
        ) {
            const alvo =
                normalizarNomeGrupo(
                    nomeGrupo
                );

            const grupo =
                gruposWhatsApp.find(
                    grupo =>
                        normalizarNomeGrupo(
                            grupo.name
                        ) === alvo
                );

            if (!grupo) {
                console.log(
                    `⚠️ Grupo "${nomeGrupo}" não encontrado para notificação.`
                );

                continue;
            }

            try {
                await client.sendText(
                    grupo.id._serialized,
                    mensagemBot
                );

                console.log(
                    `✅ Resultado enviado para: ${grupo.name}`
                );

            } catch (erro) {
                console.error(
                    `❌ Erro enviando resultado para ${grupo.name}:`,
                    erro
                );
            }

            await esperar(500);
        }

    } catch (erro) {
        console.error(
            "❌ Erro ao enviar notificações:",
            erro
        );
    }
}

// =====================================================
// LISTENER DE REAÇÕES
// =====================================================

function configurarMonitoramentoDeReacoes(
    client
) {
    client.onReactionMessage(
        async reaction => {
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

                // =============================================
                // MESSAGE ID
                // =============================================

                const idMensagemReagida =
                    reaction.msgId?._serialized ||
                    reaction.msgId;

                console.log(
                    "Mensagem reagida:",
                    idMensagemReagida
                );

                // =============================================
                // MONITORAMENTO
                // =============================================

                const monitoramento =
                    monitoramentos.get(
                        idMensagemReagida
                    );

                if (!monitoramento) {
                    console.log(
                        "⚠️ Essa mensagem não está sendo monitorada."
                    );

                    return;
                }

                console.log(
                    "Grupo:",
                    monitoramento.grupoNome
                );

                // =============================================
                // PARTICIPANTE
                // =============================================

                const participantId =
                    reaction.id?.participant ||
                    reaction.author ||
                    reaction.from;

                if (!participantId) {
                    console.log(
                        "⚠️ Participante não identificado."
                    );

                    return;
                }

                console.log(
                    "Participante:",
                    participantId
                );

                // =============================================
                // EMOTE
                // =============================================

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

                // =============================================
                // RESULTADO
                // =============================================

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

                // =============================================
                // CONTATO
                // =============================================

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
                        "⚠️ Não foi possível buscar contato:",
                        erro.message
                    );
                }

                // =============================================
                // FALLBACK NOME
                // =============================================

                if (!name) {
                    try {
                        const mensagem =
                            await client.getMessageById(
                                idMensagemReagida
                            );

                        if (mensagem?.sender) {
                            name =
                                mensagem.sender.pushname ||
                                mensagem.sender.formattedName ||
                                "";
                        }

                    } catch (erro) {
                        console.log(
                            "⚠️ Não foi possível obter sender:",
                            erro.message
                        );
                    }
                }

                // @LID NÃO É TELEFONE

                if (
                    telefone &&
                    telefone.includes("@")
                ) {
                    telefone = "";
                }

                // =============================================
                // TIMESTAMP
                // =============================================

                const timestamp =
                    reaction.timestamp ||
                    Math.floor(
                        Date.now() / 1000
                    );

                // =============================================
                // REAÇÃO REMOVIDA
                // =============================================

                if (isDeleted) {
                    console.log(
                        "\n🗑️ PROCESSANDO REMOÇÃO..."
                    );

                    await deletarReacaoMongo(
                        idMensagemReagida,
                        participantId
                    );

                    monitoramento.reacoes.delete(
                        participantId
                    );

                }

                // =============================================
                // REAÇÃO ADICIONADA
                // =============================================

                else {
                    console.log(
                        "\n💾 PROCESSANDO REAÇÃO..."
                    );

                    const dadosReacao = {
                        messageId:
                            idMensagemReagida,

                        grupoId:
                            monitoramento.grupoId,

                        grupoNome:
                            monitoramento.grupoNome,

                        fromMe:
                            reaction.id?.fromMe ??
                            false,

                        participantId,

                        name,

                        telefone,

                        emote,

                        resultado,

                        timestamp
                    };

                    await salvarReacaoMongo(
                        dadosReacao
                    );

                    monitoramento.reacoes.set(
                        participantId,
                        {
                            fromMe:
                                dadosReacao.fromMe,

                            participantId,

                            name,

                            telefone,

                            emote,

                            resultado,

                            isDeleted: false,

                            timestamp,

                            total: 0
                        }
                    );

                    // =========================================
                    // NOTIFICAÇÃO
                    // =========================================

                    if (resultado) {
                        await enviarNotificacaoReacao({
                            client,

                            grupoOrigemNome:
                                monitoramento.grupoNome,

                            emote,

                            name,

                            timestamp:
                                timestamp * 1000
                        });
                    }
                }

                // =============================================
                // TOTAL
                // =============================================

                const total =
                    await contarReacoes(
                        idMensagemReagida
                    );

                for (
                    const registro
                    of monitoramento.reacoes.values()
                ) {
                    registro.total = total;
                }

                const registroAtual =
                    monitoramento.reacoes.get(
                        participantId
                    );

                console.log(
                    "\n===== JSON DA REAÇÃO ====="
                );

                console.log(
                    JSON.stringify(
                        registroAtual ||
                        {
                            participantId,
                            name,
                            telefone,
                            emote,
                            resultado,
                            isDeleted,
                            timestamp,
                            total
                        },
                        null,
                        2
                    )
                );

                const reacoesMongo =
                    await buscarReacoes(
                        idMensagemReagida
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
                    "\nGrupo:",
                    monitoramento.grupoNome
                );

                console.log(
                    "Total:",
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
// INICIA / RECUPERA MONITORAMENTO
// =====================================================

async function iniciarMonitoramento({
    mensagem = null,
    messageId: messageIdInformado = null,
    grupoId,
    grupoNome,
    inicio = new Date(),
    fim = new Date(
        Date.now() +
        DURACAO_MONITORAMENTO
    ),
    recuperado = false
}) {
    const messageId =
        messageIdInformado ||
        mensagem?.id?._serialized ||
        mensagem?.id;

    if (!messageId) {
        throw new Error(
            `Não foi possível identificar o messageId de ${grupoNome}.`
        );
    }

    // =============================================
    // JÁ ESTÁ MONITORANDO
    // =============================================

    const existente =
        monitoramentos.get(
            messageId
        );

    if (existente) {
        return existente;
    }

    const agora = new Date();

    // =============================================
    // CICLO JÁ TERMINOU
    // =============================================

    if (fim <= agora) {
        console.log(
            `⚠️ Monitoramento ignorado para ${grupoNome}: ciclo encerrado.`
        );

        return null;
    }

    const monitoramento = {
        messageId,
        grupoId,
        grupoNome,
        mensagem,
        inicio,
        fim,
        recuperado,
        reacoes: new Map(),
        timeout: null
    };

    monitoramentos.set(
        messageId,
        monitoramento
    );

    // =============================================
    // RECUPERA REAÇÕES EXISTENTES
    // =============================================

    const totalRecuperado =
        await carregarReacoesNoMonitoramento(
            monitoramento
        );

    console.log(
        "\n================================="
    );

    console.log(
        recuperado
            ? " MONITORAMENTO RECUPERADO"
            : " MONITORAMENTO INICIADO"
    );

    console.log(
        "================================="
    );

    console.log(
        "Mensagem:",
        messageId
    );

    console.log(
        "Grupo:",
        grupoNome
    );

    console.log(
        "Grupo ID:",
        grupoId
    );

    console.log(
        "Início do ciclo:",
        inicio.toLocaleString("pt-BR")
    );

    console.log(
        "Fim do ciclo:",
        fim.toLocaleString("pt-BR")
    );

    console.log(
        "Reações recuperadas:",
        totalRecuperado
    );

    // =============================================
    // NÃO APAGA MAIS AS REAÇÕES
    // =============================================

    /*
     * IMPORTANTE:
     *
     * A versão anterior fazia:
     *
     * reacoesCollection.deleteMany({ messageId })
     *
     * Isso não pode ser feito aqui porque em caso
     * de restart apagaríamos votos já registrados.
     */

    // =============================================
    // TEMPO RESTANTE
    // =============================================

    const tempoRestante =
        Math.max(
            1,
            fim.getTime() -
            Date.now()
        );

    monitoramento.timeout =
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
                        "Grupo:",
                        grupoNome
                    );

                    await mostrarReacoes(
                        messageId
                    );

                    monitoramentos.delete(
                        messageId
                    );

                    console.log(
                        `Monitoramento removido: ${grupoNome}`
                    );

                } catch (erro) {
                    console.error(
                        "❌ Erro ao encerrar monitoramento:",
                        erro
                    );
                }
            },

            tempoRestante
        );

    return monitoramento;
}

// =====================================================
// MOSTRA REAÇÕES
// =====================================================

async function mostrarReacoes(
    messageId
) {
    console.log(
        "\n===== REAÇÕES ATUAIS ====="
    );

    const monitoramento =
        monitoramentos.get(
            messageId
        );

    const registros =
        await buscarReacoes(
            messageId
        );

    if (registros.length === 0) {
        console.log(
            "Nenhuma reação registrada."
        );

        return;
    }

    console.log(
        "Grupo:",
        monitoramento?.grupoNome ||
        registros[0]?.grupoNome ||
        "Desconhecido"
    );

    for (const registro of registros) {
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
// ENCONTRA GRUPOS
// =====================================================

async function encontrarGrupos(
    client
) {
    const chats =
        await client.listChats();

    const grupos =
        chats.filter(
            chat =>
                chat.isGroup
        );

    console.log(
        `📋 ${grupos.length} grupos encontrados no WhatsApp.`
    );

    return grupos;
}

// =====================================================
// ENVIA CHECAGEM PARA GRUPO
// =====================================================

async function enviarChecagemParaGrupo({
    client,
    grupo,
    cicloInfo = obterCicloAtivo(
        new Date()
    )
}) {
    console.log(
        "\n================================="
    );

    console.log(
        " PREPARANDO CHECAGEM"
    );

    console.log(
        "================================="
    );

    console.log(
        "Grupo:",
        grupo.name
    );

    // =============================================
    // IMAGEM DO DIA
    // =============================================

    const nomeImagem =
        obterNomeImagemAtual(
            new Date()
        );

    const imagem =
        path.join(
            __dirname,
            config.pasta_imagens,
            nomeImagem
        );

    if (!fs.existsSync(imagem)) {
        console.error(
            `❌ Imagem não encontrada: ${imagem}`
        );

        return;
    }

    const agora =
        new Date();

    const data =
        agora.toLocaleDateString(
            "pt-BR",
            {
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            }
        );

    const legenda =
        `🚨🍆 *CHECAGEM DE PAU DIÁRIA* 🍆🚨\n\n` +
        `📅 *Data:* ${data}\n\n` +
        `Senhores, está oficialmente aberta a checagem de hoje.\n\n` +
        `Reajam a *esta mensagem* de acordo com a situação atual:\n\n` +
        `👍 *DURO*\n` +
        `❤️ *MOLE*\n\n` +
        `⚠️ *Não esqueçam de reagir!* Sua participação será computada nas estatísticas oficiais da checagem.\n\n` +
        `📊 *Dashboard da Checagem:*\n` +
        `https://www.server-home.space/\n\n` +
        `Boa checagem a todos. 🫡🍆`;

    try {
        // =============================================
        // PROTEÇÃO CONTRA DUPLICIDADE
        // =============================================

        const envioExistente =
            await buscarEnvioDoCiclo(
                grupo.id._serialized,
                cicloInfo.ciclo
            );

        if (envioExistente) {
            console.log(
                `♻️ ${grupo.name} já possui checagem no ciclo ${cicloInfo.ciclo}.`
            );

            console.log(
                "Mensagem:",
                envioExistente.messageId
            );

            ultimosEnvios.set(
                normalizarNomeGrupo(
                    grupo.name
                ),
                cicloInfo.ciclo
            );

            await iniciarMonitoramento({
                messageId:
                    envioExistente.messageId,

                grupoId:
                    grupo.id._serialized,

                grupoNome:
                    grupo.name,

                inicio:
                    cicloInfo.inicio,

                fim:
                    cicloInfo.fim,

                recuperado:
                    true
            });

            return;
        }

        // =============================================
        // ENVIA
        // =============================================

        console.log(
            "Enviando imagem..."
        );

        const mensagem =
            await client.sendImage(
                grupo.id._serialized,
                imagem,
                nomeImagem,
                legenda
            );

        if (!mensagem) {
            console.error(
                `❌ WhatsApp não retornou mensagem para ${grupo.name}`
            );

            return;
        }

        const messageId =
            mensagem.id?._serialized ||
            mensagem.id;

        console.log(
            `✅ Checagem enviada para: ${grupo.name}`
        );

        console.log(
            "Mensagem:",
            messageId
        );

        // =============================================
        // SALVA O ENVIO
        // =============================================

        await salvarEnvioMongo({
            messageId,

            grupoId:
                grupo.id._serialized,

            grupoNome:
                grupo.name,

            ciclo:
                cicloInfo.ciclo,

            enviadoEm:
                agora
        });

        // =============================================
        // MONITORAMENTO
        // =============================================

        await iniciarMonitoramento({
            mensagem,

            messageId,

            grupoId:
                grupo.id._serialized,

            grupoNome:
                grupo.name,

            inicio:
                cicloInfo.inicio,

            fim:
                cicloInfo.fim,

            recuperado:
                false
        });

        ultimosEnvios.set(
            normalizarNomeGrupo(
                grupo.name
            ),
            cicloInfo.ciclo
        );

    } catch (erro) {
        console.error(
            `❌ Erro enviando para ${grupo.name}:`,
            erro
        );

        throw erro;
    }
}

// =====================================================
// ENVIA PARA GRUPO PELO NOME
// =====================================================

async function enviarChecagemParaGrupoPorNome(
    client,
    nomeGrupo,
    cicloInfo = obterCicloAtivo(
        new Date()
    )
) {
    const grupos =
        await encontrarGrupos(
            client
        );

    const alvo =
        normalizarNomeGrupo(
            nomeGrupo
        );

    const grupo =
        grupos.find(
            grupo =>
                normalizarNomeGrupo(
                    grupo.name
                ) === alvo
        );

    if (!grupo) {
        throw new Error(
            `Grupo "${nomeGrupo}" não encontrado.`
        );
    }

    await enviarChecagemParaGrupo({
        client,
        grupo,
        cicloInfo
    });
}

// =====================================================
// ENVIA PARA TODOS
// =====================================================

async function enviarChecagemParaTodos(
    client
) {
    console.log(
        "\n================================="
    );

    console.log(
        " ENVIANDO CHECAGEM PARA GRUPOS"
    );

    console.log(
        "================================="
    );

    console.log(
        "Quantidade:",
        config.grupos.length
    );

    if (config.grupos.length === 0) {
        console.log(
            "⚠️ Nenhum grupo configurado."
        );

        return;
    }

    const gruposWhatsApp =
        await encontrarGrupos(
            client
        );

    const cicloInfo =
        obterCicloAtivo(
            new Date()
        );

    for (
        const nomeGrupo
        of config.grupos
    ) {
        const grupo =
            gruposWhatsApp.find(
                grupo =>
                    normalizarNomeGrupo(
                        grupo.name
                    ) ===
                    normalizarNomeGrupo(
                        nomeGrupo
                    )
            );

        if (!grupo) {
            console.error(
                `❌ Grupo "${nomeGrupo}" não encontrado.`
            );

            continue;
        }

        await enviarChecagemParaGrupo({
            client,
            grupo,
            cicloInfo
        });

        await esperar(
            config.intervalo_reacao
        );
    }
}

// =====================================================
// RECUPERA CHECAGENS APÓS RESTART
// =====================================================

async function recuperarOuGarantirChecagens(
    client
) {
    console.log(
        "\n================================="
    );

    console.log(
        " RECUPERANDO CHECAGENS"
    );

    console.log(
        "================================="
    );

    const agora =
        new Date();

    const cicloInfo =
        obterCicloAtivo(
            agora
        );

    console.log(
        "Ciclo ativo:",
        cicloInfo.ciclo
    );

    console.log(
        "Início:",
        cicloInfo.inicio.toLocaleString(
            "pt-BR"
        )
    );

    console.log(
        "Próximo envio:",
        cicloInfo.fim.toLocaleString(
            "pt-BR"
        )
    );

    const gruposWhatsApp =
        await encontrarGrupos(
            client
        );

    for (
        const nomeGrupo
        of config.grupos
    ) {
        const alvo =
            normalizarNomeGrupo(
                nomeGrupo
            );

        const grupo =
            gruposWhatsApp.find(
                item =>
                    normalizarNomeGrupo(
                        item.name
                    ) === alvo
            );

        if (!grupo) {
            console.error(
                `❌ Grupo "${nomeGrupo}" não encontrado durante recuperação.`
            );

            continue;
        }

        const grupoId =
            grupo.id._serialized;

        // =============================================
        // PROCURA NA NOVA COLEÇÃO
        // =============================================

        let envio =
            await buscarEnvioDoCiclo(
                grupoId,
                cicloInfo.ciclo
            );

        // =============================================
        // FALLBACK PARA VERSÃO ANTIGA
        // =============================================

        if (!envio) {
            envio =
                await buscarEnvioLegadoPelasReacoes({
                    grupoId,

                    grupoNome:
                        grupo.name,

                    ciclo:
                        cicloInfo.ciclo,

                    inicio:
                        cicloInfo.inicio,

                    fim:
                        cicloInfo.fim
                });
        }

        // =============================================
        // EXISTE MENSAGEM
        // =============================================

        if (envio) {
            console.log(
                `♻️ Recuperando mensagem de ${grupo.name}`
            );

            console.log(
                "Message ID:",
                envio.messageId
            );

            ultimosEnvios.set(
                alvo,
                cicloInfo.ciclo
            );

            await iniciarMonitoramento({
                messageId:
                    envio.messageId,

                grupoId,

                grupoNome:
                    grupo.name,

                inicio:
                    cicloInfo.inicio,

                fim:
                    cicloInfo.fim,

                recuperado:
                    true
            });

            continue;
        }

        // =============================================
        // NÃO EXISTE MENSAGEM
        // =============================================

        /*
         * Estamos dentro de um ciclo que já começou.
         *
         * Portanto, se não existe mensagem registrada,
         * enviamos AGORA.
         *
         * Não importa se são 08:01, 12:00 ou 22:00.
         */

        console.log(
            `⚠️ Nenhuma checagem encontrada para ${grupo.name} no ciclo ${cicloInfo.ciclo}.`
        );

        console.log(
            "📤 Horário do ciclo já passou. Enviando agora..."
        );

        await enviarChecagemParaGrupo({
            client,
            grupo,
            cicloInfo
        });

        await esperar(
            config.intervalo_reacao
        );
    }

    console.log(
        "=================================\n"
    );
}

// =====================================================
// VERIFICA NOVO CICLO
// =====================================================

async function verificarHorarioEnvio(
    client
) {
    const agora =
        new Date();

    const horarioHoje =
        horarioEmData(
            agora,
            config.horario_envio
        );

    // Ainda não chegou o horário de hoje.

    if (agora < horarioHoje) {
        return;
    }

    const cicloHoje =
        chaveDataLocal(
            horarioHoje
        );

    for (
        const nomeGrupo
        of config.grupos
    ) {
        const chave =
            normalizarNomeGrupo(
                nomeGrupo
            );

        // Já processamos esse ciclo em memória.

        if (
            ultimosEnvios.get(
                chave
            ) === cicloHoje
        ) {
            continue;
        }

        // Marca antes para evitar concorrência.

        ultimosEnvios.set(
            chave,
            cicloHoje
        );

        const fim =
            new Date(
                horarioHoje
            );

        fim.setDate(
            fim.getDate() + 1
        );

        try {
            await enviarChecagemParaGrupoPorNome(
                client,
                nomeGrupo,
                {
                    ciclo:
                        cicloHoje,

                    inicio:
                        horarioHoje,

                    fim
                }
            );

        } catch (erro) {
            console.error(
                `❌ Erro no envio para ${nomeGrupo}:`,
                erro
            );

            // Permite tentar novamente.

            ultimosEnvios.delete(
                chave
            );
        }
    }
}

// =====================================================
// SCHEDULER
// =====================================================

function iniciarScheduler(
    client
) {
    console.log(
        "\n⏰ Scheduler iniciado."
    );

    console.log(
        "Horário configurado:",
        config.horario_envio
    );

    let verificando = false;

    setInterval(
        async () => {
            if (verificando) {
                return;
            }

            verificando = true;

            try {
                await verificarHorarioEnvio(
                    client
                );

            } catch (erro) {
                console.error(
                    "❌ Erro no scheduler:",
                    erro
                );

            } finally {
                verificando = false;
            }
        },

        5000
    );
}

// =====================================================
// AGUARDA WHATSAPP
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

            if (estado === "CONNECTED") {
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

    // =============================================
    // CONFIG
    // =============================================

    carregarConfig();

    monitorarArquivoConfig();

    // =============================================
    // LISTENER REAÇÕES
    // =============================================

    configurarMonitoramentoDeReacoes(
        client
    );

    // =============================================
    // AGUARDA WHATSAPP
    // =============================================

    await esperarWhatsAppPronto(
        client
    );

    console.log(
        "WhatsApp sincronizado!"
    );

    // =============================================
    // GRUPOS
    // =============================================

    console.log(
        "\n================================="
    );

    console.log(
        " GRUPOS CONFIGURADOS"
    );

    console.log(
        "================================="
    );

    for (
        const grupo
        of config.grupos
    ) {
        console.log(
            `• ${grupo}`
        );
    }

    console.log(
        "=================================\n"
    );

    // =============================================
    // RECUPERA ESTADO
    // =============================================

    /*
     * ESSA É A PARTE MAIS IMPORTANTE PARA O RESTART.
     *
     * Antes de iniciar o scheduler:
     *
     * 1. descobre o ciclo atual;
     * 2. procura messageId no Mongo;
     * 3. recupera monitoramento;
     * 4. se não houver mensagem, envia imediatamente.
     */

    await recuperarOuGarantirChecagens(
        client
    );

    // =============================================
    // SCHEDULER
    // =============================================

    iniciarScheduler(
        client
    );
}

// =====================================================
// INICIALIZAÇÃO
// =====================================================

async function iniciar() {
    try {
        carregarConfig();

        await conectarMongo();

        console.log(
            "\nIniciando WhatsApp..."
        );

        wppconnect
            .create({
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
                    status => {
                        console.log(
                            "Status:",
                            status
                        );
                    }
            })

            .then(
                start
            )

            .catch(
                erro => {
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

// =====================================================
// ENCERRAMENTO
// =====================================================

async function encerrar(
    sinal
) {
    console.log(
        `\n🛑 Recebido ${sinal}. Encerrando...`
    );

    try {
        if (mongoClient) {
            await mongoClient.close();
        }
    } catch (erro) {
        console.error(
            "Erro fechando MongoDB:",
            erro.message
        );
    }

    process.exit(0);
}

process.on(
    "SIGINT",
    () => encerrar("SIGINT")
);

process.on(
    "SIGTERM",
    () => encerrar("SIGTERM")
);

// =====================================================
// START
// =====================================================

iniciar();