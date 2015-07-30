var $require = require('../require')
var _ = require('lodash')
var _s = require('underscore.string')
var express = require('express')
var router = express.Router()
var paramsCheck = $require('lib/api-helpers/params-check')

/**
 *
 * @param Model
 * @param opts.actions - { create:false } will cause to disable POST action mapping
 * @param opts.populate - ['propName']
 * @returns {*}
 */
module.exports = function (Model, options) {
  options = options || {}
  var actionsMapping = {
    'create': 'POST',
    'list': 'GET',
    'retrieve': 'GET /:mongoId',
    'update': 'PUT /:mongoId',
    'remove': 'DELETE /:mongoId',
    'patch': 'PATCH /:mongoId'
  }

  var actions =  {
    'GET': function (req, res, next) {
      if (!req.pattern) req.pattern = {}
      req.pattern.deleted = { $ne: true }
      var limit = parseInt(req.query.limit, 10)

      if (limit && !isNaN(limit)) {
        var paginationQuery = {}
        if (req.query.cursor) {
          paginationQuery['before'] = req.query.cursor.toString()
        }
        if (options.sort) {
          paginatedQuery['sort'] = options.sort
        }
        var paginatedQuery = Model.paginate(paginationQuery)
          .where(req.pattern)
          .limit(limit)
        if (options.populate) {
          paginatedQuery.populate(options.populate)
        }

        paginatedQuery.execPagination(function (err, result) {
          if (err) return next(err)
          res.body = {
            cursor: result.before,
            limit: limit,
            items: result.results,
            total: result.thisPage
          }
          next()
        })
      } else {
        var allQuery = Model.find(req.pattern)
        if (options.populate) {
          allQuery.populate(options.populate)
        }
        if (options.sort) {
          allQuery.sort(options.sort)
        }
        allQuery.exec(function (err, models) {
          if (err) return next(err)
          res.body = models
          next()
        })
      }
    },
    'GET /:mongoId': function (req, res, next) {
      req.pattern = req.pattern || {}
      req.pattern._id = req.params.mongoId
      req.pattern.deleted = { $ne: true }
      Model.findOne(req.pattern, function (err, model) {
        if (err) return next(err)
        res.body = model
        if (!options.populate || !model || model.deleted) {
          return next()
        }
        model.populate(options.populate, next)
      })
    },
    'POST': function (req, res, next) {
      req.body.creator = req.session.userId
      transformRequestBody(req.body)
      Model.create(req.body, function (err, model) {
        if (err) return next(err)
        res.body = model
        if (!options.populate) {
          return next()
        }
        model.populate(options.populate, next)
      })
    },
    'PUT /:mongoId': function (req, res, next) {
      req.pattern = req.pattern || {}
      req.pattern._id = req.params.mongoId
      transformRequestBody(req.body)
      Model.findOne(req.pattern, function (err, model) {
        if (err) return next(err)
        if (!model || model.deleted) return next(not_found_resource(req.params.mongoId))
        res.body = model
        res.body.set(req.body)
        res.body.save(function (err) {
          if (err) return next(err)
          if (!options.populate) {
            return next()
          }
          model.populate(options.populate, next)
        })
      })
    },
    'PATCH /:mongoId': function (req, res, next) {
      req.pattern = req.pattern || {}
      req.pattern._id = req.params.mongoId
      transformRequestBody(req.body)
      Model.findOne(req.pattern, function (err, model) {
        if (err) return next(err)
        if (!model || model.deleted) return next(not_found_resource(req.params.mongoId))
        res.body = model
        res.body.set(req.body)
        res.body.save(function (err) {
          if (err) return next(err)
          if (!options.populate) {
            return next()
          }
          model.populate(options.populate, next)
        })
      })
    },
    'DELETE /:mongoId': function (req, res, next) {
      Model.findById(req.params.mongoId, function (err, model) {
        if (err) return next(err)
        if (!model) return next(not_found_resource(req.params.mongoId))
        model.deleted = true
        model.save(function (err) {
          if (err) return next(err)
          res.body = model
          next()
        })
      })
    }
  }

  if (options.populate) {
    options.populate = options.populate.map(function (value) {
      if (typeof value === 'string') {
        return {
          path: value,
          match: {deleted: {$ne: true}}
        }
      }
      return value
    })
  }

  function transformRequestBody(body) {
    for (var property in Model.schema.tree) {
      var pDefinition = Model.schema.tree[property][0] || Model.schema.tree[property]
      if (body[property] && pDefinition.ref) {
        if (!Array.isArray(body[property])) {
          body[property] = body[property].id || body[property]
        } else {
          body[property] = body[property].map(function (i) {
            return i.id || i
          })
        }
      }
    }
  }

  paramsCheck(router)

  if (options.actions) {
    var preActions = {}
    var postActions = {}

    for (var name in options.actions) {
      var hasNoDash = !_s.include(name, '-')

      // pass: 'any': [], skip: 'pre-any' | 'post-any'
      if (_.isArray(options.actions[name]) && hasNoDash) {
        actions[actionsMapping[name]] = options.actions[name]
        continue
      }

      // replace predefined action with new one; skip: 'pre-any' | 'post-any'
      if (_.isFunction(options.actions[name]) && hasNoDash) {
        actions[actionsMapping[name]] = options.actions[name]
        continue
      }

      // deletes 'name' action if opts.actions.name === false
      if (options.actions[name] === false && hasNoDash) {
        delete actions[actionsMapping[name]]
        continue
      }

      var prefix = name.split('-').shift()
      var endings = name.split('-').pop()
      
      // setting 'name' action to be pre-* actions
      if (prefix === 'pre' && endings === '*') {
        for (var preName in actions)
          preActions[preName] = _.flatten([ preActions[preName] || [], options.actions[name] ])
        continue
      }

      // setting 'name' action to be post-* actions
      if (prefix === 'post' && endings === '*') {
        for (var postName in actions)
          postActions[postName] = _.flatten([ postActions[postName] || [], options.actions[name] ])
        continue
      }

      // setting pre-'name' action
      if (prefix === 'pre') {
        var preName = actionsMapping[endings]
        if (!preName) throw new Error('action not found ' + name)
        preActions[preName] = _.flatten([ preActions[preName] || [], options.actions[name] ])
        continue
      }

      // setting post-'name' action
      if (prefix === 'post') {
        var postName = actionsMapping[endings]
        if (!postName) throw new Error('action not found ' + name)
        postActions[postName] = _.flatten([ postActions[postName] || [], options.actions[name] ])
        continue
      }
    }

    // merging all actions to one path
    for (var actionName in actions) {
      actions[actionName] = _.flatten([
        preActions[actionName] || [],
        actions[actionName],
        postActions[actionName] || []
      ])
    }
  }

    _.each(actions, (handlers, path) => {
    var pathChunks = path.split(' ')
    var method = pathChunks[0]
    var query = pathChunks[1] || '/'

    router[method.toLowerCase()](query, handlers)
  })

  return router
}