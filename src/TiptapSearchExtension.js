// Copyright (c) 2026 王怿武 (Github: qytwyw)

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function searchDocument(doc, searchTerm, options) {
    if (!searchTerm) return { matches: [], regex: null }

    const { caseSensitive, wholeWord, useRegex } = options

    let pattern = searchTerm
    if (!useRegex) pattern = escapeRegExp(pattern)
    if (wholeWord) pattern = `\\b${pattern}\\b`
    const flags = caseSensitive ? 'g' : 'gi'
    let regex
    try {
        regex = new RegExp(pattern, flags)
    } catch (e) {
        console.warn('Invalid regex:', e)
        return { matches: [], regex: null }
    }

    const matches = []
    doc.descendants((node, pos) => {
        if (node.isText && node.text) {
            let match
            regex.lastIndex = 0
            while ((match = regex.exec(node.text)) !== null) {
                matches.push({ from: pos + match.index, to: pos + match.index + match[0].length })
            }
        }
    })
    return { matches, regex }
}

function buildSearchMeta(state, searchTerm, options) {
    if (!searchTerm) {
        return {
            meta: {
                searchTerm: '',
                matches: [],
                currentMatchIndex: -1,
                ...options,
            },
            count: 0,
            index: -1,
        }
    }

    const { matches, regex } = searchDocument(state.doc, searchTerm, options)
    const newIndex = matches.length > 0 ? 0 : -1
    return {
        meta: {
            searchTerm,
            matches,
            currentMatchIndex: newIndex,
            cachedRegex: regex,      // 保留 regex 以便可能的外部使用，但不再用于缓存逻辑
            ...options,
        },
        count: matches.length,
        index: newIndex,
    }
}

function scrollToPosition(editor, from) {
    try {
        const domAtPos = editor.view.domAtPos(from)
        let node = domAtPos.node
        if (node.nodeType === 3) node = node.parentElement
        if (node) {
            node.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
        }
    } catch (e) { }
}

export const SearchExtension = Extension.create({
    name: 'search',

    addOptions() {
        return {
            searchResultClass: 'search-result',
            searchResultCurrentClass: 'search-result-current',
        }
    },

    addStorage() {
        return { pluginKey: null }
    },

    addProseMirrorPlugins() {
        const pluginKey = new PluginKey('search')
        this.storage.pluginKey = pluginKey
        const { searchResultClass, searchResultCurrentClass } = this.options
        const editor = this.editor

        const plugin = new Plugin({
            key: pluginKey,
            state: {
                init: () => ({
                    searchTerm: '',
                    matches: [],
                    currentMatchIndex: -1,
                    caseSensitive: false,
                    wholeWord: false,
                    useRegex: false,
                }),
                apply(tr, value, oldState, newState) {
                    const meta = tr.getMeta(pluginKey)
                    if (meta) {
                        const newValue = { ...value, ...meta }
                        // 选项改变时无需特殊处理
                        return newValue
                    }
                    if (tr.docChanged && value.searchTerm) {
                        const searchOptions = {
                            caseSensitive: value.caseSensitive,
                            wholeWord: value.wholeWord,
                            useRegex: value.useRegex,
                        }
                        const { matches, regex } = searchDocument(newState.doc, value.searchTerm, searchOptions)
                        let newIndex = value.currentMatchIndex
                        if (matches.length === 0) newIndex = -1
                        else if (newIndex >= matches.length) newIndex = matches.length - 1
                        else if (newIndex < 0) newIndex = 0
                        const newValue = {
                            ...value,
                            matches,
                            currentMatchIndex: newIndex,
                        }
                        if (editor && typeof editor.emit === 'function') {
                            Promise.resolve().then(() => {
                                editor.emit('searchResultsUpdated', {
                                    count: matches.length,
                                    currentIndex: newIndex,
                                    searchTerm: value.searchTerm,
                                })
                            })
                        }
                        return newValue
                    }
                    return value
                },
            },
            props: {
                decorations(state) {
                    const ps = pluginKey.getState(state)
                    if (!ps || !ps.matches.length) return null
                    const decos = ps.matches.map((match, idx) => {
                        const isCurrent = idx === ps.currentMatchIndex
                        const cls = isCurrent
                            ? `${searchResultClass} ${searchResultCurrentClass}`
                            : searchResultClass
                        return Decoration.inline(match.from, match.to, { class: cls })
                    })
                    return DecorationSet.create(state.doc, decos)
                },
            },
        })
        return [plugin]
    },

    addCommands() {
        return {
            find: (searchTerm) => ({ editor, state, dispatch }) => {
                const ps = editor.storage.search.pluginKey.getState(state)
                if (!ps) return false

                const options = {
                    caseSensitive: ps.caseSensitive,
                    wholeWord: ps.wholeWord,
                    useRegex: ps.useRegex,
                }
                const result = buildSearchMeta(state, searchTerm, options)
                if (!result) return false

                dispatch(state.tr.setMeta(editor.storage.search.pluginKey, result.meta))
                Promise.resolve().then(() => {
                    const newState = editor.state
                    const newPs = editor.storage.search.pluginKey.getState(newState)
                    editor.emit('searchResultsUpdated', {
                        count: newPs.matches.length,
                        currentIndex: newPs.currentMatchIndex,
                        searchTerm: newPs.searchTerm,
                    })
                })
                return true
            },

            setSearchOptions: (options) => ({ editor, state, dispatch }) => {
                const pluginKey = editor.storage.search.pluginKey
                const ps = pluginKey.getState(state)
                if (!ps) return false

                const newOptions = {
                    ...ps,
                    ...options,
                }

                if (ps.searchTerm) {
                    const result = buildSearchMeta(
                        state,
                        ps.searchTerm,
                        {
                            caseSensitive: newOptions.caseSensitive,
                            wholeWord: newOptions.wholeWord,
                            useRegex: newOptions.useRegex,
                        }
                    )
                    if (result) {
                        dispatch(state.tr.setMeta(pluginKey, { ...newOptions, ...result.meta }))
                        Promise.resolve().then(() => {
                            const newState = editor.state
                            const newPs = pluginKey.getState(newState)
                            editor.emit('searchResultsUpdated', {
                                count: newPs.matches.length,
                                currentIndex: newPs.currentMatchIndex,
                                searchTerm: newPs.searchTerm,
                            })
                        })
                        return true
                    }
                }
                dispatch(state.tr.setMeta(pluginKey, newOptions))
                return true
            },

            findNext: () => ({ editor, state, dispatch }) => {
                const pluginKey = editor.storage.search.pluginKey
                const ps = pluginKey.getState(state)
                if (!ps || ps.matches.length === 0) return false

                const next = (ps.currentMatchIndex + 1) % ps.matches.length
                const match = ps.matches[next]

                dispatch(state.tr.setMeta(pluginKey, { currentMatchIndex: next }))

                if (match) {
                    scrollToPosition(editor, match.from)
                }

                return true
            },

            findPrev: () => ({ editor, state, dispatch }) => {
                const pluginKey = editor.storage.search.pluginKey
                const ps = pluginKey.getState(state)
                if (!ps || ps.matches.length === 0) return false

                const prev = ps.currentMatchIndex <= 0 ? ps.matches.length - 1 : ps.currentMatchIndex - 1
                const match = ps.matches[prev]

                dispatch(state.tr.setMeta(pluginKey, { currentMatchIndex: prev }))

                if (match) {
                    scrollToPosition(editor, match.from)
                }

                return true
            },

            replace: (replaceText) => ({ editor, state, dispatch }) => {
                const pluginKey = editor.storage.search.pluginKey
                const ps = pluginKey.getState(state)
                if (!ps || ps.currentMatchIndex === -1) return false

                const match = ps.matches[ps.currentMatchIndex]
                let tr = state.tr
                if (replaceText === '') {
                    tr = tr.delete(match.from, match.to)
                } else {
                    tr = tr.replaceWith(match.from, match.to, state.schema.text(replaceText))
                }
                dispatch(tr)

                const newState = editor.state

                if (ps.searchTerm) {
                    const options = {
                        caseSensitive: ps.caseSensitive,
                        wholeWord: ps.wholeWord,
                        useRegex: ps.useRegex,
                    }
                    const { matches, regex } = searchDocument(newState.doc, ps.searchTerm, options)
                    let newIndex = ps.currentMatchIndex
                    if (matches.length === 0) {
                        newIndex = -1
                    } else if (newIndex >= matches.length) {
                        newIndex = matches.length - 1
                    } else if (newIndex < 0 && matches.length > 0) {
                        newIndex = 0
                    } else {
                        if (newIndex >= matches.length) newIndex = matches.length - 1
                    }
                    dispatch(newState.tr.setMeta(pluginKey, {
                        ...ps,
                        matches,
                        currentMatchIndex: newIndex,
                    }))
                    if (newIndex !== -1 && matches[newIndex]) {
                        scrollToPosition(editor, matches[newIndex].from)
                    }
                    editor.emit('searchResultsUpdated', {
                        count: matches.length,
                        currentIndex: newIndex,
                        searchTerm: ps.searchTerm,
                    })
                } else {
                    dispatch(newState.tr.setMeta(pluginKey, {
                        searchTerm: '',
                        matches: [],
                        currentMatchIndex: -1,
                    }))
                }
                return true
            },

            replaceAll: (replaceText) => ({ editor, state, dispatch }) => {
                const pluginKey = editor.storage.search.pluginKey
                const ps = pluginKey.getState(state)
                if (!ps || ps.matches.length === 0) return false

                let tr = state.tr
                for (let i = ps.matches.length - 1; i >= 0; i--) {
                    const match = ps.matches[i]
                    if (replaceText === '') {
                        tr = tr.delete(match.from, match.to)
                    } else {
                        tr = tr.replaceWith(match.from, match.to, state.schema.text(replaceText))
                    }
                }
                dispatch(tr)
                return true
            },

            clearSearch: () => ({ editor, state, dispatch }) => {
                const pluginKey = editor.storage.search.pluginKey
                dispatch(state.tr.setMeta(pluginKey, {
                    searchTerm: '',
                    matches: [],
                    currentMatchIndex: -1,
                }))
                return true
            },

            getMatchCount: () => ({ editor, state }) => {
                const ps = editor.storage.search.pluginKey.getState(state)
                return ps ? ps.matches.length : 0
            },

            getCurrentMatchIndex: () => ({ editor, state }) => {
                const ps = editor.storage.search.pluginKey.getState(state)
                return ps ? ps.currentMatchIndex : -1
            },

            getSearchState: () => ({ editor, state }) => {
                return editor.storage.search.pluginKey.getState(state)
            },
        }
    },

    addKeyboardShortcuts() {
        return {
            'F3': () => {
                this.editor.commands.findNext()
                return true
            },
            'Shift-F3': () => {
                this.editor.commands.findPrev()
                return true
            },
            'Mod-g': () => {
                this.editor.commands.findNext()
                return true
            },
            'Mod-Shift-g': () => {
                this.editor.commands.findPrev()
                return true
            },
        }
    },
})
